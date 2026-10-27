#!/usr/bin/env node
// Standalone in-process SSH/SFTP server for LIVE verification of the plugin
// (bb sshfs connect/ls/cat/write/...) without an external sshd. Backed by a
// temp directory; prints `PORT=<n> HOME=<dir>` then serves until SIGINT.
import { mkdtempSync, writeFileSync } from "node:fs";
import { readdir, mkdir, open, stat, unlink, rmdir, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import ssh2 from "ssh2";

const { Server } = ssh2;

const USER = "smoke";
const PASSWORD = "smokepw";

const HOST_KEY = `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
QyNTUxOQAAACB5SA29+nglczw/82N2Pv54wGnfblM4SQwbs1ZZrtF/RgAAAKA64rC+OuKw
vgAAAAtzc2gtZWQyNTUxOQAAACB5SA29+nglczw/82N2Pv54wGnfblM4SQwbs1ZZrtF/Rg
AAAEDY1WPufWwLtAZp2ckK8VXHhR+sXE744+K7sLFFnGPtwXlIDb36eCVzPD/zY3Y+/njA
ad9uUzhJDBuzVlmu0X9GAAAAFm1pZnRhaHVsaHVkYUBJVEktMDA5NDkBAgMEBQYH
-----END OPENSSH PRIVATE KEY-----`;

const OPEN_MODE = { READ: 1, WRITE: 2, CREAT: 8, TRUNC: 16 };
const STATUS = { OK: 0, EOF: 1, NO_SUCH_FILE: 2, FAILURE: 4 };

const home = mkdtempSync(join(tmpdir(), "sshfs-dev-"));
writeFileSync(join(home, "hello.txt"), "hello from the dev sftp server\n");
writeFileSync(join(home, "README.md"), "# Dev mount\n\nEdit me over SSH FS.\n");

const openFiles = new Map();
const openDirs = new Map();
let handleSeq = 1;

const resolvePath = (remote) => {
  const relative = remote.startsWith(home) ? remote.slice(home.length) : remote;
  const cleaned = relative.replace(/^\/+/, "").replace(/\/+$/, "");
  return resolve(join(home, cleaned === "" ? "" : cleaned));
};

const server = new Server({ hostKeys: [HOST_KEY] }, (client) => {
  client
    .on("authentication", (ctx) => {
      if (ctx.method === "password" && ctx.username === USER && ctx.password === PASSWORD) {
        ctx.accept();
      } else {
        ctx.reject();
      }
    })
    .on("ready", () => {
      client.on("session", (accept) => {
        const session = accept();
        session
          .on("exec", (acceptExec, _reject, info) => {
            const stream = acceptExec();
            if (String(info.command).includes("$HOME")) stream.write(home);
            stream.exit(0);
            stream.close();
          })
          .on("sftp", (acceptSftp) => {
            const sftp = acceptSftp();
            const fail = (reqid, code) => sftp.status(reqid, code);
            const attrsOf = async (path) => {
              const info = await stat(path);
              return {
                mode: info.mode,
                uid: 0,
                gid: 0,
                size: info.size,
                atime: Math.floor(info.atimeMs / 1000),
                mtime: Math.floor(info.mtimeMs / 1000),
              };
            };
            sftp
              .on("OPEN", async (reqid, filename, flags) => {
                const isWrite = (flags & (OPEN_MODE.WRITE | OPEN_MODE.TRUNC)) !== 0;
                const isRead = (flags & OPEN_MODE.READ) !== 0 && !isWrite;
                if (!isWrite && !isRead) return fail(reqid, STATUS.FAILURE);
                try {
                  const fd = await open(resolvePath(filename), isWrite ? "w" : "r");
                  openFiles.set(handleSeq, { fd });
                  sftp.handle(reqid, Buffer.from(String(handleSeq++)));
                } catch {
                  fail(reqid, STATUS.FAILURE);
                }
              })
              .on("READ", async (reqid, handle, offset, length) => {
                const entry = openFiles.get(Number(handle.toString()));
                if (entry === undefined) return fail(reqid, STATUS.FAILURE);
                const buffer = Buffer.alloc(length);
                try {
                  const { bytesRead } = await entry.fd.read(buffer, 0, length, offset);
                  if (bytesRead === 0) return fail(reqid, STATUS.EOF);
                  sftp.data(reqid, buffer.subarray(0, bytesRead));
                } catch {
                  fail(reqid, STATUS.FAILURE);
                }
              })
              .on("WRITE", async (reqid, handle, offset, data) => {
                const entry = openFiles.get(Number(handle.toString()));
                if (entry === undefined) return fail(reqid, STATUS.FAILURE);
                try {
                  await entry.fd.write(data, 0, data.length, offset);
                  sftp.status(reqid, STATUS.OK);
                } catch {
                  fail(reqid, STATUS.FAILURE);
                }
              })
              .on("CLOSE", async (reqid, handle) => {
                const id = Number(handle.toString());
                const file = openFiles.get(id);
                if (file !== undefined) {
                  openFiles.delete(id);
                  await file.fd.close().catch(() => undefined);
                }
                openDirs.delete(id);
                sftp.status(reqid, STATUS.OK);
              })
              .on("OPENDIR", (reqid, path) => {
                openDirs.set(handleSeq, { path: resolvePath(path), finished: false });
                sftp.handle(reqid, Buffer.from(String(handleSeq++)));
              })
              .on("READDIR", async (reqid, handle) => {
                const dir = openDirs.get(Number(handle.toString()));
                if (dir === undefined) return fail(reqid, STATUS.FAILURE);
                if (dir.finished) return fail(reqid, STATUS.EOF);
                dir.finished = true;
                try {
                  const names = await readdir(dir.path);
                  const entries = [];
                  for (const name of names) {
                    entries.push({ filename: name, longname: "x", attrs: await attrsOf(join(dir.path, name)) });
                  }
                  if (entries.length === 0) return fail(reqid, STATUS.EOF);
                  sftp.name(reqid, entries);
                } catch {
                  fail(reqid, STATUS.FAILURE);
                }
              })
              .on("STAT", async (reqid, path) => {
                try {
                  sftp.attrs(reqid, await attrsOf(resolvePath(path)));
                } catch {
                  fail(reqid, STATUS.NO_SUCH_FILE);
                }
              })
              .on("LSTAT", (reqid, path) => sftp.emit("STAT", reqid, path))
              .on("MKDIR", async (reqid, path) => {
                try {
                  await mkdir(resolvePath(path));
                  sftp.status(reqid, STATUS.OK);
                } catch {
                  fail(reqid, STATUS.FAILURE);
                }
              })
              .on("RMDIR", async (reqid, path) => {
                try {
                  await rmdir(resolvePath(path));
                  sftp.status(reqid, STATUS.OK);
                } catch {
                  fail(reqid, STATUS.FAILURE);
                }
              })
              .on("REMOVE", async (reqid, path) => {
                try {
                  await unlink(resolvePath(path));
                  sftp.status(reqid, STATUS.OK);
                } catch {
                  fail(reqid, STATUS.NO_SUCH_FILE);
                }
              })
              .on("RENAME", async (reqid, from, to) => {
                try {
                  await rename(resolvePath(from), resolvePath(to));
                  sftp.status(reqid, STATUS.OK);
                } catch {
                  fail(reqid, STATUS.FAILURE);
                }
              })
              .on("REALPATH", (reqid, path) => {
                sftp.name(reqid, [
                  { filename: resolvePath(path), longname: "x", attrs: { mode: 0o100644, uid: 0, gid: 0, size: 0, atime: 0, mtime: 0 } },
                ]);
              });
          });
      });
    });
});

server.listen(0, "127.0.0.1", () => {
  const { port } = server.address();
  console.log(`PORT=${port}`);
  console.log(`HOME=${home}`);
});

process.on("SIGINT", () => {
  server.close(() => process.exit(0));
});