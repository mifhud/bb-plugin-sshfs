// SFTP session abstraction + connection manager.
//
// The manager keys one connection per mount (config name), mirrors
// vscode-sshfs's "existing connections are reused" behavior, and closes idle
// connections after a configurable timeout. Every operation takes a lease so
// an in-flight call is never cut off by the idle timer.
import { Client, type ConnectConfig, type SFTPWrapper, type Stats } from "ssh2";
import { kindFromMode, sortEntries } from "./paths";
import type { FsEntry, SshFsConfig } from "../contract";

/** Normalized error thrown for every failed SFTP operation. */
export class SftpError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SftpError";
  }
}

const NO_SUCH_FILE = 2;
const PERMISSION_DENIED = 3;

function friendlySftpError(name: string, error: unknown): SftpError {
  const code = (error as { code?: number | string } | null)?.code;
  if (code === NO_SUCH_FILE) return new SftpError(`${name}: not found`, { cause: error });
  if (code === PERMISSION_DENIED) return new SftpError(`${name}: permission denied`, { cause: error });
  const message = error instanceof Error ? error.message : String(error);
  return new SftpError(`${name}: ${message}`, { cause: error });
}

// -- Promisified ssh2 SFTP primitives ---------------------------------------

function connectClient(options: ConnectConfig): Promise<Client> {
  const { promise, resolve, reject } = Promise.withResolvers<Client>();
  const client = new Client();
  const onError = (error: Error) => {
    client.removeListener("ready", onReady);
    reject(error);
  };
  const onReady = () => {
    client.removeListener("error", onError);
    resolve(client);
  };
  client.once("ready", onReady);
  client.once("error", onError);
  client.connect(options);
  return promise;
}

function openSftp(client: Client): Promise<SFTPWrapper> {
  const { promise, resolve, reject } = Promise.withResolvers<SFTPWrapper>();
  client.sftp((error, sftp) => {
    if (error) reject(error);
    else resolve(sftp);
  });
  return promise;
}

/** ssh2 callback convention (errors may be null). */
type NodeCallback<Result> = (error: Error | null | undefined, result?: Result) => void;

/** Invoke one ssh2 operation and await its callback. */
function call<Result>(invoke: (callback: NodeCallback<Result>) => void): Promise<Result> {
  const { promise, resolve, reject } = Promise.withResolvers<Result>();
  invoke((error, result) => {
    if (error) reject(error);
    else resolve(result as Result);
  });
  return promise;
}

// -- Session abstraction ----------------------------------------------------

/** One interactive shell (PTY) channel on an SSH connection. */
export interface ShellChannel {
  /** Unique ID shared with the frontend for RPC routing. */
  id: string;
  /** Write data (keystrokes or pasted text) to the shell's stdin. */
  write(data: string): void;
  /** Resize the PTY. */
  resize(cols: number, rows: number): void;
  /** Close the shell channel (idempotent). */
  close(): void;
  /** Register a listener for shell output (stdout + stderr merged). */
  onData(callback: (data: string) => void): void;
  /** Register a listener that fires when the channel closes. */
  onClose(callback: () => void): void;
}

/** Everything the server needs from a live SSH connection (SFTP + shell). */
export interface SftpSession {
  /** Literal `~`/`~/...` root expansion via a remote shell (POSIX servers). */
  expandHome(root: string): Promise<string>;
  listDir(absPath: string): Promise<FsEntry[]>;
  /** Read a file; refuses files larger than `maxBytes` before transferring them. */
  readFile(
    absPath: string,
    maxBytes: number,
  ): Promise<{ buffer: Buffer; size: number; mtimeMs: number | null; mode: number | null }>;
  writeFile(absPath: string, content: Buffer): Promise<{ size: number; mtimeMs: number | null }>;
  mkdir(absPath: string): Promise<void>;
  delete(absPath: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** Open a PTY shell on the remote server. */
  shell(cols: number, rows: number): Promise<ShellChannel>;
  /** Tear down the underlying SSH transport (idempotent). */
  close(): void;
}

interface ReadDirEntry {
  filename: string;
  attrs: Stats;
}

export function realSession(sftp: SFTPWrapper, client: Client): SftpSession {
  const readdirP = (path: string) =>
    call<ReadDirEntry[]>((callback) => sftp.readdir(path, callback));
  const lstatP = (path: string) =>
    call<Stats>((callback) => sftp.lstat(path, callback));

  async function statKind(absPath: string): Promise<FsEntry["kind"]> {
    const stats = await lstatP(absPath);
    return kindFromMode(stats.mode);
  }

  return {
    async expandHome(root) {
      if (root === "/" || !root.startsWith("~")) return root;
      const { promise, resolve, reject } = Promise.withResolvers<string>();
      client.exec('printf %s "$HOME"', (error, stream) => {
        if (error) {
          reject(new SftpError(`Cannot expand ~: ${error.message}`, { cause: error }));
          return;
        }
        let out = "";
        stream.on("data", (chunk: Buffer) => {
          out += chunk.toString("utf8");
        });
        stream.stderr.on("data", () => undefined);
        stream.on("close", (code: number) => {
          if (code !== 0 || out.trim() === "") {
            reject(new SftpError("Cannot expand ~: remote HOME is empty"));
            return;
          }
          resolve(out.trim());
        });
        stream.on("error", reject);
      });
      const home = await promise;
      const rest = root.slice(1); // "/..." or ""
      return rest === "" ? home : `${home}${rest}`;
    },

    async listDir(absPath) {
      let raw: ReadDirEntry[];
      try {
        raw = await readdirP(absPath);
      } catch (error) {
        throw friendlySftpError(`list ${absPath}`, error);
      }
      const entries: FsEntry[] = [];
      for (const { filename, attrs } of raw) {
        if (filename === "." || filename === "..") continue;
        let kind = kindFromMode(attrs.mode);
        if (attrs.mode === 0) kind = await statKind(`${absPath}/${filename}`);
        entries.push({
          name: filename,
          kind,
          size: attrs.size,
          mtimeMs: attrs.mtime ? attrs.mtime * 1000 : null,
          mode: attrs.mode || null,
        });
      }
      return sortEntries(entries);
    },

    async readFile(absPath, maxBytes) {
      let stats: Stats;
      try {
        stats = await lstatP(absPath);
      } catch (error) {
        throw friendlySftpError(`read ${absPath}`, error);
      }
      if (stats.isDirectory()) throw new SftpError(`read ${absPath}: is a directory`);
      if (stats.size > maxBytes) {
        throw new SftpError(
          `read ${absPath}: file is ${stats.size} bytes (max ${maxBytes})`,
        );
      }
      let buffer: Buffer;
      try {
        buffer = await call<Buffer>((callback) => sftp.readFile(absPath, callback));
      } catch (error) {
        throw friendlySftpError(`read ${absPath}`, error);
      }
      return {
        buffer,
        size: buffer.length,
        mtimeMs: stats.mtime ? stats.mtime * 1000 : null,
        mode: stats.mode || null,
      };
    },

    async writeFile(absPath, content) {
      let existing: Stats | null = null;
      try {
        existing = await lstatP(absPath);
      } catch {
        existing = null;
      }
      const mode = existing ? existing.mode & 0o777 : 0o644;
      let handle: Buffer;
      try {
        // Flags must be the string "w", not the numeric mode: ssh2 treats a
        // number as raw SSH_FXF bits, so mode 0644 (420) reaches real servers
        // as READ|WRITE|CREAT|TRUNC all unset — opens fail with "not found"
        // or leave files truncated/empty. Attr mode keeps the original
        // permissions on overwrite.
        handle = await call<Buffer>((callback) =>
          sftp.open(absPath, "w", { mode }, callback),
        );
      } catch (error) {
        throw friendlySftpError(`write ${absPath}`, error);
      }
      try {
        await call<void>((callback) =>
          sftp.write(handle, content, 0, content.length, 0, callback),
        );
      } catch (error) {
        throw friendlySftpError(`write ${absPath}`, error);
      } finally {
        void call<void>((callback) => sftp.close(handle, callback)).catch(() => undefined);
      }
      let after: Stats | null = null;
      try {
        after = await lstatP(absPath);
      } catch {
        after = null;
      }
      return {
        size: content.length,
        mtimeMs: after?.mtime ? after.mtime * 1000 : null,
      };
    },

    async mkdir(absPath) {
      try {
        await call<void>((callback) => sftp.mkdir(absPath, callback));
      } catch (error) {
        throw friendlySftpError(`mkdir ${absPath}`, error);
      }
    },

    async delete(absPath) {
      let stats: Stats;
      try {
        stats = await lstatP(absPath);
      } catch (error) {
        throw friendlySftpError(`delete ${absPath}`, error);
      }
      if (stats.isDirectory()) {
        let entries: ReadDirEntry[];
        try {
          entries = await readdirP(absPath);
        } catch (error) {
          throw friendlySftpError(`delete ${absPath}`, error);
        }
        for (const { filename } of entries) {
          if (filename === "." || filename === "..") continue;
          await this.delete(`${absPath}/${filename}`);
        }
        try {
          await call<void>((callback) => sftp.rmdir(absPath, callback));
        } catch (error) {
          throw friendlySftpError(`delete ${absPath}`, error);
        }
        return;
      }
      try {
        await call<void>((callback) => sftp.unlink(absPath, callback));
      } catch (error) {
        throw friendlySftpError(`delete ${absPath}`, error);
      }
    },

    async rename(from, to) {
      try {
        await call<void>((callback) => sftp.rename(from, to, callback));
      } catch (error) {
        throw friendlySftpError(`rename ${from}`, error);
      }
    },

    close() {
      client.end();
    },

    async shell(cols, rows) {
      const { promise, resolve, reject } = Promise.withResolvers<ShellChannel>();
      client.shell(
        { cols, rows, term: "xterm-256color" },
        (err, stream) => {
          if (err) {
            reject(new SftpError(`Cannot open shell: ${err.message}`, { cause: err }));
            return;
          }
          const id = crypto.randomUUID();
          const dataCallbacks = new Set<(data: string) => void>();
          const closeCallbacks = new Set<() => void>();
          stream.on("data", (chunk: Buffer) => {
            const data = chunk.toString("utf8");
            for (const cb of dataCallbacks) cb(data);
          });
          stream.stderr.on("data", (chunk: Buffer) => {
            const data = chunk.toString("utf8");
            for (const cb of dataCallbacks) cb(data);
          });
          stream.on("close", () => {
            for (const cb of closeCallbacks) cb();
          });
          const channel: ShellChannel = {
            id,
            write(data: string) {
              stream.write(data);
            },
            resize(cols: number, rows: number) {
              stream.setWindow(rows, cols, 0, 0);
            },
            close() {
              stream.close();
            },
            onData(callback: (data: string) => void) {
              dataCallbacks.add(callback);
            },
            onClose(callback: () => void) {
              closeCallbacks.add(callback);
            },
          };
          resolve(channel);
        },
      );
      return promise;
    },
  };

}

// -- Live connection ---------------------------------------------------------

export interface MountInfo {
  name: string;
  host: string;
  user: string;
  port: number;
  root: string;
  connectedAt: number;
}

interface Mount {
  name: string;
  rootRaw: string;
  session: SftpSession;
  root: string;
  info: MountInfo;
  leases: number;
  /** Number of open shell (PTY) channels pinning the connection. */
  shellCount: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  closed: boolean;
}

type ConnectSession = (options: ConnectConfig) => Promise<SftpSession>;

/** One open shell (PTY) channel, tracked by the manager. */
interface ShellEntry {
  channel: ShellChannel;
  mount: Mount;
  closed: boolean;
}

/** Real ssh2-backed session factory (also used by the smoke test). */
export const connectSession: ConnectSession = async (options) => {
  const client = await connectClient(options);
  const sftp = await openSftp(client);
  return realSession(sftp, client);
};

export interface SftpManagerOptions {
  /** Close a mount's connection after this many ms with no operations. 0 = never. */
  idleTimeoutMs?: number;
  log?: (line: string) => void;
  connectSession?: ConnectSession;
}

/** One connection per mount, lazily opened, idle-closed, config-change aware. */
export class SftpManager {
  private readonly mounts = new Map<string, Mount>();
  private idleTimeoutMs: number;
  private readonly shells = new Map<string, ShellEntry>();
  private readonly log: (line: string) => void;
  private readonly connectSession: ConnectSession;

  constructor(options: SftpManagerOptions = {}) {
    this.idleTimeoutMs = options.idleTimeoutMs ?? 0;
    this.log = options.log ?? (() => undefined);
    this.connectSession = options.connectSession ?? connectSession;
  }

  isConnected(name: string): boolean {
    const mount = this.mounts.get(name);
    return mount !== undefined && !mount.closed;
  }

  /** Change the idle-close timeout (0 = never close idle connections). */
  setIdleTimeoutMs(ms: number): void {
    this.idleTimeoutMs = Math.max(0, ms);
    if (ms <= 0) {
      for (const mount of this.mounts.values()) this.cancelIdleClose(mount);
    }
  }

  connectedNames(): string[] {
    return [...this.mounts.values()].filter((mount) => !mount.closed).map((mount) => mount.name);
  }

  /** Open (or reuse) the mount's connection and run one operation against it. */
  async withSession<T>(
    name: string,
    config: SshFsConfig,
    connectOptions: ConnectConfig,
    fn: (session: SftpSession, root: string) => Promise<T>,
  ): Promise<T> {
    const mount = await this.ensureConnected(name, config, connectOptions);
    mount.leases += 1;
    this.cancelIdleClose(mount);
    try {
      return await fn(mount.session, mount.root);
    } finally {
      mount.leases -= 1;
      this.scheduleIdleClose(mount);
    }
  }

  private async ensureConnected(
    name: string,
    config: SshFsConfig,
    connectOptions: ConnectConfig,
  ): Promise<Mount> {
    const existing = this.mounts.get(name);
    if (existing !== undefined && !existing.closed) {
      // The configured root (or auth) changed since connect: reopen.
      if (existing.rootRaw === config.root) return existing;
      this.closeMount(existing, "config changed");
    }
    const mount = await this.open(name, config, connectOptions);
    this.mounts.set(name, mount);
    void this.log(
      `connected ${name} (${connectOptions.username}@${connectOptions.host}:${connectOptions.port})`,
    );
    return mount;
  }

  private async open(
    name: string,
    config: SshFsConfig,
    connectOptions: ConnectConfig,
  ): Promise<Mount> {
    let session: SftpSession;
    try {
      session = await this.connectSession(connectOptions);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new SftpError(
        `Connection to ${connectOptions.username}@${connectOptions.host} failed: ${message}`,
        { cause: error },
      );
    }
    const root = await session.expandHome(config.root ?? "/");
    return {
      name,
      rootRaw: config.root ?? "/",
      session,
      root,
      info: {
        name,
        host: connectOptions.host ?? "",
        user: connectOptions.username ?? "",
        port: connectOptions.port ?? 22,
        root,
        connectedAt: Date.now(),
      },
      leases: 0,
      shellCount: 0,
      idleTimer: null,
      closed: false,
    };
  }

  /** Reconnect a mount and return the fresh mount's identity (CLI/UI connect). */
  async connect(
    name: string,
    config: SshFsConfig,
    connectOptions: ConnectConfig,
  ): Promise<MountInfo> {
    const mount = await this.ensureConnected(name, config, connectOptions);
    return mount.info;
  }

  /** Close the connection for one mount. Returns whether it was open. */
  async disconnect(name: string): Promise<boolean> {
    const mount = this.mounts.get(name);
    if (mount === undefined || mount.closed) return false;
    this.closeMount(mount, "disconnect");
    return true;
  }

  /**
   * Open a PTY shell on a mount. Reuses the existing SSH connection (or
   * opens one). The caller is responsible for resolving paths and sending
   * `cd <path>` via the returned channel's `write` method before publishing
   * the session ID to the frontend.
   */
  async openShell(
    name: string,
    config: SshFsConfig,
    connectOptions: ConnectConfig,
    cols: number,
    rows: number,
  ): Promise<{ channel: ShellChannel; root: string }> {
    const mount = await this.ensureConnected(name, config, connectOptions);
    mount.shellCount += 1;
    this.cancelIdleClose(mount);
    const channel = await mount.session.shell(cols, rows);
    const entry: ShellEntry = { channel, mount, closed: false };
    this.shells.set(channel.id, entry);
    channel.onClose(() => {
      if (entry.closed) return;
      entry.closed = true;
      this.shells.delete(channel.id);
      mount.shellCount = Math.max(0, mount.shellCount - 1);
      this.scheduleIdleClose(mount);
    });
    return { channel, root: mount.root };
  }

  /** Write data (keystrokes) to an open shell session. */
  shellWrite(sessionId: string, data: string): void {
    const entry = this.shells.get(sessionId);
    if (entry === undefined || entry.closed) {
      throw new SftpError(`Shell session not found: ${sessionId}`);
    }
    entry.channel.write(data);
  }

  /** Resize the PTY of an open shell session. */
  shellResize(sessionId: string, cols: number, rows: number): void {
    const entry = this.shells.get(sessionId);
    if (entry === undefined || entry.closed) {
      throw new SftpError(`Shell session not found: ${sessionId}`);
    }
    entry.channel.resize(cols, rows);
  }

  /** Close a shell session, releasing its lease on the mount. */
  shellClose(sessionId: string): boolean {
    const entry = this.shells.get(sessionId);
    if (entry === undefined || entry.closed) return false;
    entry.closed = true;
    entry.channel.close();
    this.shells.delete(sessionId);
    entry.mount.shellCount = Math.max(0, entry.mount.shellCount - 1);
    this.scheduleIdleClose(entry.mount);
    void this.log(`closed shell ${sessionId}`);
    return true;
  }

  closeAll(): void {
    for (const entry of this.shells.values()) {
      if (!entry.closed) entry.channel.close();
    }
    this.shells.clear();
    for (const mount of this.mounts.values()) {
      if (!mount.closed) this.closeMount(mount, "shutdown");
    }
  }

  private scheduleIdleClose(mount: Mount): void {
    if (mount.leases > 0 || mount.closed || this.idleTimeoutMs <= 0 || mount.shellCount > 0) return;
    mount.idleTimer = setTimeout(() => {
      if (mount.leases === 0 && !mount.closed) this.closeMount(mount, "idle");
    }, this.idleTimeoutMs);
  }

  private cancelIdleClose(mount: Mount): void {
    if (mount.idleTimer !== null) {
      clearTimeout(mount.idleTimer);
      mount.idleTimer = null;
    }
  }

  private closeMount(mount: Mount, reason: string): void {
    if (mount.closed) return;
    mount.closed = true;
    this.cancelIdleClose(mount);
    // Close any open shell channels for this mount before tearing down the SSH transport.
    for (const [id, entry] of this.shells) {
      if (entry.mount === mount && !entry.closed) {
        entry.closed = true;
        entry.channel.close();
        this.shells.delete(id);
      }
    }
    mount.shellCount = 0;
    try {
      mount.session.close();
    } catch (error) {
      void this.log(
        `close ${mount.name} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    void this.log(`closed ${mount.name} (${reason})`);
  }
}