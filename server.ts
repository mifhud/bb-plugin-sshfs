// bb-plugin-sshfs — mount remote directories over SSH and browse, open, and
// edit files over SFTP, mimicking vscode-sshfs. One connection per config
// (reused across UI and CLI), idle-closed; all file paths are relative to the
// config's root, traversal is refused.
import { cliCommand, defineCli, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  CLI_LIST_MAX_ENTRIES,
  MAX_FILE_BYTES,
  configSchema,
  rpcContract,
  SSHF_CHANGED,
  SSHF_TERMINAL_DATA,
  type ConfigSecrets,
  type ConfigView,
  type SshFsConfig,
} from "./contract";
import {
  normalizeConfigs,
  parseSecrets,
  sshConnectConfig,
  validateConfigs,
} from "./lib/config";
import { isBinaryBuffer, resolveRemote } from "./lib/paths";
import { ShellChannel, SftpManager, type MountInfo, type SftpSession } from "./lib/sftp";

export { rpcContract } from "./contract";

const configsJsonSchema = z
  .string()
  .refine((value) => {
    try {
      JSON.parse(value);
      return true;
    } catch {
      return false;
    }
  }, "Must be a valid JSON array of configs");

const secretsJsonSchema = z
  .string()
  .refine((value) => {
    try {
      JSON.parse(value);
      return true;
    } catch {
      return false;
    }
  }, "Must be a valid JSON object: { name: { password?, passphrase? } }");

export default async function plugin(bb: BbPluginApi): Promise<void> {
  const settings = bb.settings.define({
    configs: {
      type: "string",
      label: "SSH FS configs (JSON array)",
      description:
        '[{"name":"prod","host":"10.0.0.5","user":"deploy","root":"/srv/app",' +
        '"port":22,"keyPath":"/home/me/.ssh/id_ed25519"}]. ' +
        "Host is the host only — the SSH user has its own field. Root is the " +
        "mounted directory (`/`, `~/path`, or any absolute POSIX path).",
      experimental_multiline: true,
      experimental_schema: configsJsonSchema,
      default: "[]",
    },
    secrets: {
      type: "string",
      label: "Secrets (JSON, server-only)",
      description:
        'JSON object keyed by config name: {"prod":{"password":"…",' +
        '"passphrase":"…"}}. Set with `bb plugin config sshfs set secrets \'{"prod":{"password":"…"}}\'` ' +
        "or from the SSH FS config dialog.",
      secret: true,
      experimental_schema: secretsJsonSchema,
    },
    idleTimeoutSeconds: {
      type: "number",
      label: "Close idle connections after (seconds, 0 = keep open)",
      description:
        "Each mount's SSH connection closes after this long without " +
        "operations; the next browse or edit reconnects automatically.",
      experimental_schema: z.number().int().min(0).max(3600),
      default: 60,
    },
    sessionRememberSeconds: {
      type: "number",
      label: "Remember mount sessions (seconds, 0 = off)",
      description:
        "The SSH FS page remembers where each mount was and auto-reconnects " +
        "mounts that were connected recently (idle-closed) when you return, " +
        "restoring the last directory. Once a disconnected mount's window " +
        "has elapsed its remembered directory is forgotten, so the next " +
        "connect lands on the mount root. Manual disconnects always end the " +
        "session. 0 disables auto-reconnect.",
      experimental_schema: z.number().int().min(0).max(86400),
      default: 600,
    },
  });

  const manager = new SftpManager({
    idleTimeoutMs: 60_000, // replaced once settings load below
    log: (line) => bb.log.debug(line),
  });

  /** Fresh configs + secrets + idle timeout from settings, normalized. */
  async function loadState(): Promise<{
    configs: SshFsConfig[];
    secrets: ConfigSecrets;
    idleTimeoutMs: number;
  }> {
    const values = await settings.get();
    let configs: SshFsConfig[] = [];
    try {
      configs = validateConfigs(JSON.parse(values.configs));
    } catch (error) {
      bb.log.error(`Invalid configs setting: ${error instanceof Error ? error.message : String(error)}`);
    }
    let secrets: ConfigSecrets = {};
    try {
      secrets = parseSecrets(values.secrets);
    } catch (error) {
      bb.log.error(`Invalid secrets setting: ${error instanceof Error ? error.message : String(error)}`);
    }
    return {
      configs,
      secrets,
      idleTimeoutMs: (values.idleTimeoutSeconds ?? 60) * 1000,
    };
  }

  manager.setIdleTimeoutMs((await loadState()).idleTimeoutMs);
  settings.onChange(async () => {
    const state = await loadState();
    manager.setIdleTimeoutMs(state.idleTimeoutMs);
    // Configs removed/renamed (or secrets edited) invalidate open sessions.
    const known = new Set(state.configs.map((config) => config.name));
    for (const name of manager.connectedNames()) {
      if (!known.has(name)) {
        await manager.disconnect(name);
        bb.realtime.publish(SSHF_CHANGED, { kind: "state", name, connected: false });
      }
    }
    bb.realtime.publish(SSHF_CHANGED, { kind: "configs" });
    void bb.log.info(`settings changed (${state.configs.length} configs)`);
  });

  function configView(config: SshFsConfig, secrets: ConfigSecrets): ConfigView {
    return {
      ...config,
      connected: manager.isConnected(config.name),
      hasPassword: secrets[config.name]?.password !== undefined,
    };
  }

  /** Resolve a config + secrets and open/reuse its SSH connection. */
  async function connectMount(name: string): Promise<MountInfo> {
    const { configs, secrets } = await loadState();
    const config = configs.find((candidate) => candidate.name === name);
    if (config === undefined) throw new Error(`No SSH FS config named "${name}". Run "bb sshfs list".`);
    return manager.connect(name, config, sshConnectConfig(config, secrets));
  }

  /** Open (or reuse) the mount's connection, then close it unless it was already open. */
  async function testConnection(name: string): Promise<number> {
    const { configs, secrets } = await loadState();
    const config = configs.find((candidate) => candidate.name === name);
    if (config === undefined) throw new Error(`No SSH FS config named "${name}". Run "bb sshfs list".`);
    const started = Date.now();
    const alreadyConnected = manager.isConnected(name);
    await manager.connect(name, config, sshConnectConfig(config, secrets));
    const latencyMs = Date.now() - started;
    if (!alreadyConnected) await manager.disconnect(name);
    return latencyMs;
  }

  /** Run one file operation against a mount by config name. */
  async function withMount<T>(
    name: string,
    fn: (session: SftpSession, root: string) => Promise<T>,
  ): Promise<T> {
    const { configs, secrets } = await loadState();
    const config = configs.find((candidate) => candidate.name === name);
    if (config === undefined) throw new Error(`No SSH FS config named "${name}". Run "bb sshfs list".`);
    return manager.withSession(name, config, sshConnectConfig(config, secrets), fn);
  }

  /**
   * Validate root-relative paths BEFORE any connection is attempted, so
   * traversal or malformed input fails fast instead of opening a session.
   */
  async function guardPaths(name: string, rels: string[]): Promise<void> {
    const { configs } = await loadState();
    const config = configs.find((candidate) => candidate.name === name);
    if (config === undefined) throw new Error(`No SSH FS config named "${name}". Run "bb sshfs list".`);
    for (const rel of rels) resolveRemote(config.root ?? "/", rel);
  }

  function publishState(name: string, connected: boolean): void {
    bb.realtime.publish(SSHF_CHANGED, { kind: "state", name, connected });
  }

  /** Convert any thrown error into an Error with a readable message. */
  function cliError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
  }

  function formatMtime(mtimeMs: number): string {
    return new Date(mtimeMs).toISOString().slice(0, 16).replace("T", " ");
  }

  // -- RPC (frontend data plane) --------------------------------------------
  bb.rpc.register(rpcContract, {
    configs_list: async () => {
      const { configs, secrets } = await loadState();
      return { configs: configs.map((config) => configView(config, secrets)) };
    },
    configs_save: async ({ configs }) => {
      const normalized = normalizeConfigs(validateConfigs(configs));
      await settings.experimental_set({ configs: JSON.stringify(normalized) });
      const state = await loadState();
      return { configs: state.configs.map((config) => configView(config, state.secrets)) };
    },
    secrets_set: async ({ name, password }) => {
      const state = await loadState();
      if (!state.configs.some((config) => config.name === name)) {
        throw new Error(`No SSH FS config named "${name}". Run "bb sshfs list".`);
      }
      const entry = state.secrets[name] ?? {};
      if (password === null) delete entry.password;
      else entry.password = password;
      const next: ConfigSecrets = { ...state.secrets };
      if (entry.passphrase === undefined && entry.password === undefined) delete next[name];
      else next[name] = entry;
      await settings.experimental_set({ secrets: JSON.stringify(next) });
      return { hasPassword: entry.password !== undefined };
    },
    settings_get: async () => {
      const values = await settings.get();
      return { sessionRememberSeconds: values.sessionRememberSeconds ?? 600 };
    },
    mounts_connect: async ({ name }) => {
      const info = await connectMount(name);
      publishState(name, true);
      return { connected: true, root: info.root, user: info.user, host: info.host, port: info.port };
    },
    mounts_disconnect: async ({ name }) => {
      const disconnected = await manager.disconnect(name);
      publishState(name, false);
      return { disconnected };
    },
    mounts_test: async ({ name }) => ({
      ok: true,
      latencyMs: await testConnection(name),
    }),
    fs_list: async ({ mount, path }) => {
      await guardPaths(mount, [path]);
      return withMount(mount, async (session, root) => {
        const entries = await session.listDir(resolveRemote(root, path));
        return {
          path,
          entries: entries.slice(0, CLI_LIST_MAX_ENTRIES),
          truncated: entries.length > CLI_LIST_MAX_ENTRIES,
        };
      });
    },
    fs_read: async ({ mount, path }) => {
      await guardPaths(mount, [path]);
      return withMount(mount, async (session, root) => {
        const abs = resolveRemote(root, path);
        const { buffer, mtimeMs } = await session.readFile(abs, MAX_FILE_BYTES);
        const isBinary = isBinaryBuffer(buffer);
        return {
          path,
          content: isBinary ? "" : buffer.toString("utf8"),
          size: buffer.length,
          mtimeMs,
          isBinary,
        };
      });
    },
    fs_write: async ({ mount, path, content }) => {
      await guardPaths(mount, [path]);
      return withMount(mount, async (session, root) => {
        const abs = resolveRemote(root, path);
        const buffer = Buffer.from(content, "utf8");
        if (buffer.byteLength > MAX_FILE_BYTES) {
          throw new Error(`File too large: ${buffer.byteLength} bytes (max ${MAX_FILE_BYTES})`);
        }
        return session.writeFile(abs, buffer);
      });
    },
    fs_mkdir: async ({ mount, path }) => {
      await guardPaths(mount, [path]);
      return withMount(mount, async (session, root) => {
        await session.mkdir(resolveRemote(root, path));
        return { created: true };
      });
    },
    fs_delete: async ({ mount, path }) => {
      await guardPaths(mount, [path]);
      return withMount(mount, async (session, root) => {
        await session.delete(resolveRemote(root, path));
        return { removed: true };
      });
    },
    fs_rename: async ({ mount, from, to }) => {
      await guardPaths(mount, [from, to]);
      return withMount(mount, async (session, root) => {
        await session.rename(resolveRemote(root, from), resolveRemote(root, to));
        return { renamed: true };
      });
    },
    terminal_open: async ({ mount: name, path, cols, rows }) => {
      await guardPaths(name, [path]);
      const { configs, secrets } = await loadState();
      const config = configs.find((candidate) => candidate.name === name);
      if (config === undefined) throw new Error(`No SSH FS config named "${name}". Run "bb sshfs list".`);
      const connectOptions = sshConnectConfig(config, secrets);
      // Resolve the mount root so `cd` targets the correct absolute path on
      // the remote host. `connect` reuses the existing connection if already open.
      const { root } = await manager.connect(name, config, connectOptions);
      const absPath = resolveRemote(root, path);
      const { channel } = await manager.openShell(name, config, connectOptions, cols, rows);
      // Change directory to the requested path inside the new PTY shell.
      channel.write(`cd '${absPath}'\n`);
      // Stream shell output (stdout + stderr, merged) to the frontend via realtime.
      channel.onData((data) => {
        bb.realtime.publish(SSHF_TERMINAL_DATA, { sessionId: channel.id, data });
      });
      channel.onClose(() => {
        bb.realtime.publish(SSHF_TERMINAL_DATA, { sessionId: channel.id, closed: true });
      });
      return { sessionId: channel.id };
    },
    terminal_write: async ({ sessionId, data }) => {
      manager.shellWrite(sessionId, data);
      return { written: true };
    },
    terminal_resize: async ({ sessionId, cols, rows }) => {
      manager.shellResize(sessionId, cols, rows);
      return { resized: true };
    },
    terminal_close: async ({ sessionId }) => {
      const closed = manager.shellClose(sessionId);
      return { closed };
    },
  });

  // -- CLI (`bb sshfs …`) ---------------------------------------------------
  const cli = defineCli({
    name: "sshfs",
    summary: "Mount remote directories over SSH and browse, open, and edit files via SFTP",
    commands: {
      list: cliCommand({
        summary: "List SSH FS configs and connection state",
        options: { json: { type: "boolean", description: "Print JSON" } },
        run: async ({ options }) => {
          const { configs, secrets } = await loadState();
          if (options.json) {
            return { exitCode: 0, stdout: JSON.stringify(configs.map((config) => configView(config, secrets))) };
          }
          if (configs.length === 0) {
            return {
              exitCode: 0,
              stdout:
                "No SSH FS configs. Add one with\n" +
                "  bb plugin config sshfs set configs '[{\"name\":\"myhost\",\"host\":\"10.0.0.5\",\"user\":\"deploy\",\"root\":\"/\"}]'",
            };
          }
          const lines = configs.map((config) => {
            const state = manager.isConnected(config.name) ? "connected" : "disconnected";
            return `${state.padEnd(13)} ${config.name.padEnd(24)} ${config.host} :${config.root}`;
          });
          return { exitCode: 0, stdout: lines.join("\n") };
        },
      }),
      connect: cliCommand({
        summary: "Open the SSH connection for a config",
        positionals: [{ name: "name", description: "Config name", required: true }],
        run: async ({ positionals }) => {
          try {
            const info = await connectMount(positionals.name);
            publishState(info.name, true);
            return {
              exitCode: 0,
              stdout: `Connected to ${info.user}@${info.host}:${info.port}, mounted ${info.root}`,
            };
          } catch (error) {
            throw cliError(error);
          }
        },
      }),
      disconnect: cliCommand({
        summary: "Close the SSH connection for a config",
        positionals: [{ name: "name", description: "Config name", required: true }],
        run: async ({ positionals }) => {
          const closed = await manager.disconnect(positionals.name);
          publishState(positionals.name, false);
          return {
            exitCode: 0,
            stdout: closed ? `Disconnected ${positionals.name}` : `${positionals.name} was not connected`,
          };
        },
      }),
      test: cliCommand({
        summary: "Verify the SSH connection (auth + SFTP + root) for a config",
        positionals: [{ name: "name", description: "Config name", required: true }],
        run: async ({ positionals }) => {
          try {
            const latencyMs = await testConnection(positionals.name);
            return { exitCode: 0, stdout: `OK (${latencyMs} ms)` };
          } catch (error) {
            throw cliError(error);
          }
        },
      }),
      ls: cliCommand({
        summary: "List a remote directory (relative to the mount root)",
        positionals: [
          { name: "name", description: "Config name", required: true },
          { name: "path", description: "Remote path (default: mount root)" },
        ],
        run: async ({ positionals }) => {
          const path = positionals.path ?? ".";
          try {
            await guardPaths(positionals.name, [path]);
            const { entries, truncated } = await withMount(positionals.name, async (session, root) => {
              const listed = await session.listDir(resolveRemote(root, path));
              return {
                entries: listed.slice(0, CLI_LIST_MAX_ENTRIES),
                truncated: listed.length > CLI_LIST_MAX_ENTRIES,
              };
            });
            const lines = entries.map((entry) => {
              const kind = entry.kind === "dir" ? "d" : entry.kind === "link" ? "l" : "-";
              const size = entry.kind === "dir" ? "" : String(entry.size);
              const mtime = entry.mtimeMs === null ? "" : formatMtime(entry.mtimeMs);
              return `${kind} ${size.padStart(10)} ${mtime.padEnd(17)} ${entry.name}`;
            });
            const header = `${path === "." ? "/" : path}:\n`;
            const body = lines.length === 0 ? "(empty)" : lines.join("\n");
            const tail = truncated ? `\n… ${entries.length} entries shown (truncated)` : "";
            return { exitCode: 0, stdout: `${header}${body}${tail}\n` };
          } catch (error) {
            throw cliError(error);
          }
        },
      }),
      cat: cliCommand({
        summary: "Print a remote text file to stdout",
        positionals: [
          { name: "name", description: "Config name", required: true },
          { name: "path", description: "Remote path", required: true },
        ],
        run: async ({ positionals }) => {
          try {
            await guardPaths(positionals.name, [positionals.path]);
            const result = await withMount(positionals.name, async (session, root) => {
              const abs = resolveRemote(root, positionals.path);
              const { buffer, mtimeMs } = await session.readFile(abs, MAX_FILE_BYTES);
              const isBinary = isBinaryBuffer(buffer);
              return {
                content: isBinary ? "" : buffer.toString("utf8"),
                isBinary,
                size: buffer.length,
                mtimeMs,
              };
            });
            if (result.isBinary) {
              return {
                exitCode: 1,
                stderr: `cat ${positionals.path}: binary file (${result.size} bytes), refusing to print`,
              };
            }
            return { exitCode: 0, stdout: result.content };
          } catch (error) {
            throw cliError(error);
          }
        },
      }),
      write: cliCommand({
        summary: "Write text to a remote file (overwrites)",
        positionals: [
          { name: "name", description: "Config name", required: true },
          { name: "path", description: "Remote path", required: true },
        ],
        options: { content: { type: "string", description: "Text to write", required: true } },
        run: async ({ positionals, options }) => {
          try {
            await guardPaths(positionals.name, [positionals.path]);
            const buffer = Buffer.from(options.content, "utf8");
            if (buffer.byteLength > MAX_FILE_BYTES) {
              throw new Error(`Content too large: ${buffer.byteLength} bytes (max ${MAX_FILE_BYTES})`);
            }
            const { size } = await withMount(positionals.name, (session, root) =>
              session.writeFile(resolveRemote(root, positionals.path), buffer),
            );
            return { exitCode: 0, stdout: `Wrote ${size} bytes to ${positionals.path}` };
          } catch (error) {
            throw cliError(error);
          }
        },
      }),
      mkdir: cliCommand({
        summary: "Create a remote directory",
        positionals: [
          { name: "name", description: "Config name", required: true },
          { name: "path", description: "Remote path", required: true },
        ],
        run: async ({ positionals }) => {
          try {
            await guardPaths(positionals.name, [positionals.path]);
            await withMount(positionals.name, (session, root) =>
              session.mkdir(resolveRemote(root, positionals.path)),
            );
            return { exitCode: 0, stdout: `Created ${positionals.path}` };
          } catch (error) {
            throw cliError(error);
          }
        },
      }),
      rm: cliCommand({
        summary: "Delete a remote file or directory (recursive)",
        positionals: [
          { name: "name", description: "Config name", required: true },
          { name: "path", description: "Remote path", required: true },
        ],
        run: async ({ positionals }) => {
          try {
            await guardPaths(positionals.name, [positionals.path]);
            await withMount(positionals.name, (session, root) =>
              session.delete(resolveRemote(root, positionals.path)),
            );
            return { exitCode: 0, stdout: `Deleted ${positionals.path}` };
          } catch (error) {
            throw cliError(error);
          }
        },
      }),
      mv: cliCommand({
        summary: "Move/rename a remote file or directory",
        positionals: [
          { name: "name", description: "Config name", required: true },
          { name: "from", description: "Source path", required: true },
          { name: "to", description: "Destination path", required: true },
        ],
        run: async ({ positionals }) => {
          try {
            await guardPaths(positionals.name, [positionals.from, positionals.to]);
            await withMount(positionals.name, (session, root) =>
              session.rename(
                resolveRemote(root, positionals.from),
                resolveRemote(root, positionals.to),
              ),
            );
            return { exitCode: 0, stdout: `Moved ${positionals.from} → ${positionals.to}` };
          } catch (error) {
            throw cliError(error);
          }
        },
      }),
    },
  });
  bb.cli.register(cli);

  bb.onDispose(() => {
    manager.closeAll();
    bb.log.info("disposed");
  });
}