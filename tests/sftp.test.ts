// SftpManager lifecycle + realSession behavior against an in-memory SFTP
// implementation (no real SSH needed).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { realSession, SftpError, SftpManager } from "../lib/sftp";
import type { SftpManagerOptions, SftpSession } from "../lib/sftp";

// -- Memory SFTP wrapper mimicking ssh2's SFTPWrapper callback API -----------

interface MemFile {
  data: Buffer;
  mode: number;
  mtime: number;
}

class MemorySftp {
  files = new Map<string, MemFile>(); // absolute path -> entry
  private nextHandle = 1;
  private handles = new Map<number, string>();

  seed(path: string, data: string, mode = 0o100644): void {
    this.files.set(path, { data: Buffer.from(data, "utf8"), mode, mtime: 1_700_000_000 });
  }

  private isDirPath(path: string): boolean {
    if (path === "/") return this.files.size > 0;
    const prefix = `${path}/`;
    for (const key of this.files.keys()) {
      if (key.startsWith(prefix)) return true;
    }
    return false;
  }

  private attrs(path: string) {
    const file = this.files.get(path);
    const isDir = file === undefined && this.isDirPath(path);
    return {
      mode: file?.mode ?? (isDir ? 0o040755 : 0),
      size: file?.data.length ?? 0,
      mtime: file?.mtime ?? 0,
      isDirectory: () => isDir,
    };
  }

  readdir(path: string, cb: (err: Error | null, list?: { filename: string; attrs: unknown }[]) => void): void {
    if (!this.isDirPath(path)) {
      cb(Object.assign(new Error("ENOENT"), { code: 2 }));
      return;
    }
    const prefix = path === "/" ? "/" : `${path}/`;
    const names = new Set<string>();
    for (const key of this.files.keys()) {
      if (key.startsWith(prefix)) {
        const name = key.slice(prefix.length).split("/")[0];
        if (name !== "") names.add(name);
      }
    }
    cb(null, [...names].map((filename) => ({ filename, attrs: this.attrs(`${prefix}${filename}`) })));
  }

  lstat(path: string, cb: (err: Error | null, attrs?: unknown) => void): void {
    if (this.files.get(path) === undefined && !this.isDirPath(path)) {
      cb(Object.assign(new Error("ENOENT"), { code: 2 }));
      return;
    }
    cb(null, this.attrs(path));
  }

  readFile(path: string, cb: (err: Error | null, data?: Buffer) => void): void {
    const file = this.files.get(path);
    if (file === undefined) {
      cb(Object.assign(new Error("ENOENT"), { code: 2 }));
      return;
    }
    cb(null, Buffer.from(file.data));
  }

  open(path: string, mode: number, cb: (err: Error | null, handle?: Buffer) => void): void {
    const id = this.nextHandle++;
    this.handles.set(id, path);
    // Existing file keeps its mode; a brand-new file takes the requested mode.
    if (!this.files.has(path)) this.files.set(path, { data: Buffer.alloc(0), mode: 0o100000 | mode, mtime: 0 });
    cb(null, Buffer.from(String(id)));
  }

  write(
    handle: Buffer,
    data: Buffer,
    _offset: number,
    length: number,
    _position: number,
    cb: (err: Error | null) => void,
  ): void {
    const path = this.handles.get(Number(handle.toString()));
    const file = path === undefined ? undefined : this.files.get(path);
    if (file === undefined) {
      cb(new Error("EINVAL"));
      return;
    }
    file.data = Buffer.from(data.subarray(0, length));
    file.mtime = 1_700_000_001;
    cb(null);
  }

  close(handle: Buffer, cb: (err: Error | null) => void): void {
    this.handles.delete(Number(handle.toString()));
    cb(null);
  }

  unlink(path: string, cb: (err: Error | null) => void): void {
    if (this.files.delete(path)) cb(null);
    else cb(Object.assign(new Error("ENOENT"), { code: 2 }));
  }

  rmdir(path: string, cb: (err: Error | null) => void): void {
    const prefix = `${path}/`;
    const hasChildren = [...this.files.keys()].some((key) => key.startsWith(prefix));
    if (hasChildren) {
      cb(new Error("ENOTEMPTY"));
      return;
    }
    cb(null);
  }

  rename(from: string, to: string, cb: (err: Error | null) => void): void {
    const file = this.files.get(from);
    if (file === undefined) {
      cb(Object.assign(new Error("ENOENT"), { code: 2 }));
      return;
    }
    this.files.delete(from);
    this.files.set(to, file);
    cb(null);
  }
}

function memorySession(): SftpSession {
  const sftp = new MemorySftp();
  const client = { exec: () => { throw new Error("expandHome not used here"); } } as never;
  return realSession(sftp as never, client);
}

function fakeSession(calls: string[]): SftpSession {
  return {
    expandHome: async (root) => root,
    listDir: async () => {
      calls.push("listDir");
      return [];
    },
    readFile: async () => ({ buffer: Buffer.from("x"), size: 1, mtimeMs: 1, mode: 0o100644 }),
    writeFile: async () => ({ size: 1, mtimeMs: 1 }),
    mkdir: async () => undefined,
    delete: async () => undefined,
    rename: async () => undefined,
    close: () => undefined,
  };
}

// -- Manager lifecycle --------------------------------------------------------

describe("SftpManager", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function createManager(options: SftpManagerOptions = {}) {
    const calls: string[] = [];
    let connects = 0;
    return {
      calls,
      connects: () => connects,
      manager: new SftpManager({
        connectSession: async () => {
          connects += 1;
          return fakeSession(calls);
        },
        ...options,
      }),
    };
  }

  it("reuses one connection and reopens when the root changes", async () => {
    const { calls, connects, manager: mgr } = createManager();
    const cfg = { name: "dev", host: "user@host", root: "/" };
    await mgr.withSession("dev", cfg, {}, (session) => session.listDir("/"));
    await mgr.withSession("dev", cfg, {}, (session) => session.listDir("/"));
    expect(connects()).toBe(1);
    expect(calls).toEqual(["listDir", "listDir"]);

    await mgr.withSession("dev", { ...cfg, root: "/other" }, {}, (session) => session.listDir("/"));
    expect(connects()).toBe(2);
    mgr.closeAll();
  });

  it("expands ~ roots once per connection and reuses them", async () => {
    let expands = 0;
    const sessions = new SftpManager({
      connectSession: async () => ({
        ...fakeSession([]),
        expandHome: async (root) => {
          expands += 1;
          return root === "~" ? "/home/me" : root;
        },
      }),
    });
    const cfg = { name: "dev", host: "user@host", root: "~" };
    await sessions.withSession("dev", cfg, {}, () => Promise.resolve());
    await sessions.withSession("dev", cfg, {}, () => Promise.resolve());
    expect(expands).toBe(1);
    sessions.closeAll();
  });

  it("closes idle connections after the timeout but never leased work", async () => {
    const { manager: mgr } = createManager({ idleTimeoutMs: 30_000 });
    const cfg = { name: "dev", host: "user@host", root: "/" };
    await mgr.withSession("dev", cfg, {}, () => Promise.resolve());
    expect(mgr.isConnected("dev")).toBe(true);

    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    const op = mgr.withSession("dev", cfg, {}, async () => {
      await gate;
      return undefined;
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mgr.isConnected("dev")).toBe(true); // lease protects the session
    release();
    await op;
    await vi.advanceTimersByTimeAsync(31_000);
    expect(mgr.isConnected("dev")).toBe(false);
    mgr.closeAll();
  });

  it("disconnect, reconnect, and closeAll are idempotent", async () => {
    const { manager: mgr } = createManager();
    const cfg = { name: "dev", host: "user@host", root: "/" };
    await mgr.connect("dev", cfg, {});
    expect(mgr.isConnected("dev")).toBe(true);
    expect(await mgr.disconnect("dev")).toBe(true);
    expect(await mgr.disconnect("dev")).toBe(false);
    await mgr.connect("a", cfg, {});
    await mgr.connect("b", { ...cfg, name: "b" }, {});
    mgr.closeAll();
    expect(mgr.connectedNames()).toEqual([]);
  });

  it("reports connection failures with host context", async () => {
    const broken = new SftpManager({
      connectSession: async () => {
        throw new Error("timed out");
      },
    });
    await expect(broken.connect("dev", { name: "dev", host: "h" }, { username: "u", host: "h" })).rejects.toThrow(
      /Connection to u@h failed: timed out/,
    );
    expect(broken.isConnected("dev")).toBe(false);
  });
});

// -- realSession ops ----------------------------------------------------------

describe("realSession", () => {
  it("lists dirs first with kinds, skipping dot entries", async () => {
    const sftp = new MemorySftp();
    sftp.seed("/srv/a.txt", "a");
    sftp.seed("/srv/.hidden", "h");
    sftp.seed("/srv/src/x.js", "x");
    const session = realSession(sftp as never, { exec: () => undefined } as never);
    const entries = await session.listDir("/srv");
    expect(entries.map((entry) => [entry.name, entry.kind])).toEqual([
      ["src", "dir"],
      [".hidden", "file"],
      ["a.txt", "file"],
    ]);
    const a = entries.find((entry) => entry.name === "a.txt");
    expect(a?.size).toBe(1);
    expect(a?.mtimeMs).toBe(1_700_000_000 * 1000);
  });

  it("refuses oversized and directory reads", async () => {
    const sftp = new MemorySftp();
    sftp.seed("/big.txt", "x".repeat(100));
    sftp.seed("/d/file.txt", "y");
    const session = realSession(sftp as never, { exec: () => undefined } as never);
    await expect(session.readFile("/big.txt", 10)).rejects.toThrow(/max 10/);
    await expect(session.readFile("/d", 1000)).rejects.toThrow(/is a directory/);
  });

  it("writes preserving the existing mode", async () => {
    const sftp = new MemorySftp();
    sftp.seed("/doc.txt", "old", 0o100600);
    const session = realSession(sftp as never, { exec: () => undefined } as never);
    const result = await session.writeFile("/doc.txt", Buffer.from("new content"));
    expect(result.size).toBe(11);
    expect(sftp.files.get("/doc.txt")?.data.toString()).toBe("new content");
    expect(sftp.files.get("/doc.txt")?.mode).toBe(0o100600);
  });

  it("creates new files with a default mode", async () => {
    const sftp = new MemorySftp();
    const session = realSession(sftp as never, { exec: () => undefined } as never);
    await session.writeFile("/fresh.txt", Buffer.from("hi"));
    expect(sftp.files.get("/fresh.txt")?.mode).toBe(0o100644);
  });

  it("deletes recursively and renames", async () => {
    const sftp = new MemorySftp();
    sftp.seed("/tree/a.txt", "a");
    sftp.seed("/tree/sub/b.txt", "b");
    const session = realSession(sftp as never, { exec: () => undefined } as never);
    await session.delete("/tree");
    expect([...sftp.files.keys()]).toEqual([]);

    sftp.seed("/old.txt", "o");
    await session.rename("/old.txt", "/new.txt");
    expect(sftp.files.has("/old.txt")).toBe(false);
    expect(sftp.files.has("/new.txt")).toBe(true);
  });

  it("maps missing files to a friendly error and throws SftpError", async () => {
    const session = memorySession();
    await expect(session.readFile("/missing", 1000)).rejects.toThrow(/not found/);
    await expect(session.listDir("/missing")).rejects.toThrow(/not found/);
    await expect(session.delete("/missing")).rejects.toThrow(/not found/);
    await expect(session.readFile("/missing", 1000)).rejects.toBeInstanceOf(SftpError);
  });
});