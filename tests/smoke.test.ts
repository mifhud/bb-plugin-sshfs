// End-to-end smoke: an in-process ssh2 Server (real SSH transport, real
// SFTP protocol) backed by a temp directory on disk, driven through the
// plugin's actual client stack (sshConnectConfig → connectSession →
// realSession → SftpManager). Proves SSH connection + browse + open/edit/save
// without needing an external sshd.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readdir, mkdir, open, stat, unlink, rmdir, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Server } from "ssh2";
import { connectSession, SftpManager } from "../lib/sftp";
import { sshConnectConfig } from "../lib/config";

// Fixed SFTP v3 protocol constants (stable; ssh2 does not export them).
const OPEN_MODE = { READ: 1, WRITE: 2, CREAT: 8, TRUNC: 16 };
const STATUS = {
  OK: 0,
  EOF: 1,
  NO_SUCH_FILE: 2,
  FAILURE: 4,
};

// Test-only host key (ed25519, no passphrase).
const HOST_KEY = `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
QyNTUxOQAAACB5SA29+nglczw/82N2Pv54wGnfblM4SQwbs1ZZrtF/RgAAAKA64rC+OuKw
vgAAAAtzc2gtZWQyNTUxOQAAACB5SA29+nglczw/82N2Pv54wGnfblM4SQwbs1ZZrtF/Rg
AAAEDY1WPufWwLtAZp2ckK8VXHhR+sXE744+K7sLFFnGPtwXlIDb36eCVzPD/zY3Y+/njA
ad9uUzhJDBuzVlmu0X9GAAAAFm1pZnRhaHVsaHVkYUBJVEktMDA5NDkBAgMEBQYH
-----END OPENSSH PRIVATE KEY-----`;

const USER = "smoke";
const PASSWORD = "smokepw";

interface SmokeServer {
  port: number;
  home: string;
  connections: () => number;
  close: () => Promise<void>;
}

function startServer(): Promise<SmokeServer> {
  const home = mkdtempSync(join(tmpdir(), "sshfs-smoke-"));
  let connections = 0;
  const openFiles = new Map<number, { fd: import("node:fs/promises").FileHandle }>();
  const openDirs = new Map<number, { path: string; finished: boolean }>();
  let handleSeq = 1;

  // Client paths are absolute as seen from the mount root — the smoke home
  // IS the SFTP root. Normalize either encoding (home-prefixed or `/-relative`)
  // back onto the local temp dir.
  const resolvePath = (remote: string) => {
    const relative = remote.startsWith(home) ? remote.slice(home.length) : remote;
    const cleaned = relative.replace(/^\/+/, "").replace(/\/+$/, "");
    return resolve(join(home, cleaned === "" ? "" : cleaned));
  };

  const server = new Server({ hostKeys: [HOST_KEY] }, (client) => {
    connections += 1;
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
              const fail = (reqid: number, code: number) => sftp.status(reqid, code);
              const attrsOf = async (path: string) => {
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
                  if (dir.finished) {
                    return fail(reqid, STATUS.EOF);
                  }
                  dir.finished = true;
                  try {
                    const names = await readdir(dir.path);
                    const entries = [];
                    for (const name of names) {
                      entries.push({
                        filename: name,
                        longname: "x",
                        attrs: await attrsOf(join(dir.path, name)),
                      });
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
                    {
                      filename: resolvePath(path),
                      longname: "x",
                      attrs: { mode: 0o100644, uid: 0, gid: 0, size: 0, atime: 0, mtime: 0 },
                    },
                  ]);
                });
            });
        });
      });
  });

  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as { port: number };
      resolvePromise({
        port: address.port,
        home,
        connections: () => connections,
        close: async () => {
          await new Promise<void>((done) => server.close(() => done()));
          rmSync(home, { recursive: true, force: true });
        },
      });
    });
  });
}

let current: SmokeServer | null = null;

afterEach(async () => {
  if (current !== null) {
    await current.close();
    current = null;
  }
});

describe("end-to-end over a real SSH transport", () => {
  it("connects, browses, opens, edits, and saves files", async () => {
    const server = await startServer();
    current = server;
    writeFileSync(join(server.home, "hello.txt"), "hello from the smoke test\n");

    const manager = new SftpManager({ idleTimeoutMs: 0 });
    const config = { name: "smoke", host: `${USER}@127.0.0.1`, port: server.port, root: "/" };
    const options = sshConnectConfig(config, { smoke: { password: PASSWORD } });

    // Browse: list the mount root.
    const rootEntries = await manager.withSession("smoke", config, options, (session, root) =>
      session.listDir(root),
    );
    expect(rootEntries.map((entry) => entry.name)).toContain("hello.txt");

    // Open: read the file.
    const read = await manager.withSession("smoke", config, options, (session, root) =>
      session.readFile(`${root === "/" ? "" : root}/hello.txt`, 1024 * 1024),
    );
    expect(read.buffer.toString()).toBe("hello from the smoke test\n");

    // Edit/save: overwrite, then read back.
    await manager.withSession("smoke", config, options, (session, root) =>
      session.writeFile(`${root}/hello.txt`, Buffer.from("edited remotely\n")),
    );
    const after = await manager.withSession("smoke", config, options, (session, root) =>
      session.readFile(`${root}/hello.txt`, 1024 * 1024),
    );
    expect(after.buffer.toString()).toBe("edited remotely\n");

    // Create folders, move, list nested, delete recursively.
    await manager.withSession("smoke", config, options, (session, root) =>
      session.mkdir(`${root}/sub`),
    );
    await manager.withSession("smoke", config, options, (session, root) =>
      session.rename(`${root}/hello.txt`, `${root}/sub/moved.txt`),
    );
    const sub = await manager.withSession("smoke", config, options, (session, root) =>
      session.listDir(`${root}/sub`),
    );
    expect(sub.map((entry) => entry.name)).toEqual(["moved.txt"]);

    // One connection per mount: a second op reuses it.
    const connectionsBefore = server.connections();
    await manager.withSession("smoke", config, options, (session, root) => session.listDir(root));
    expect(server.connections()).toBe(connectionsBefore);

    await manager.withSession("smoke", config, options, (session, root) =>
      session.delete(`${root}/sub`),
    );
    const final = await manager.withSession("smoke", config, options, (session, root) =>
      session.listDir(root),
    );
    expect(final).toEqual([]);
    manager.closeAll();
  });

  it("expands ~ roots over the exec channel and refuses oversized reads", async () => {
    const server = await startServer();
    current = server;
    writeFileSync(join(server.home, "home.txt"), "in home");

    const manager = new SftpManager({ idleTimeoutMs: 0 });
    const config = { name: "home", host: `${USER}@127.0.0.1`, port: server.port, root: "~" };
    const options = sshConnectConfig(config, { home: { password: PASSWORD } });

    // root "~" resolves via exec "$HOME" to the smoke home dir.
    const entries = await manager.withSession("home", config, options, (session, root) =>
      session.listDir(root),
    );
    expect(entries.map((entry) => entry.name)).toContain("home.txt");

    // Size cap is enforced at the transport level.
    writeFileSync(join(server.home, "big.bin"), Buffer.alloc(2048, 1));
    await expect(
      manager.withSession("home", config, options, (session, root) =>
        session.readFile(`${root}/big.bin`, 128),
      ),
    ).rejects.toThrow(/max 128/);
    manager.closeAll();
  });
});