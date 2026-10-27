// SSH FS config helpers: host validation and ssh2 connection options.
import { existsSync, readFileSync } from "node:fs";
import type { ConnectConfig } from "ssh2";
import {
  configSchema,
  secretsSchema,
  type ConfigSecrets,
  type SshFsConfig,
} from "../contract";
import { normalizeRoot } from "./paths";

/**
 * Full ssh2 options for one config, with secrets applied. The SSH username
 * always comes from the `user` field — `host` is the host only.
 */
export function sshConnectConfig(
  config: SshFsConfig,
  secrets: ConfigSecrets,
): ConnectConfig {
  const user = config.user;
  if (!user) throw new Error(`No SSH user for "${config.host}" (set "user" in the config)`);
  const secret = secrets[config.name] ?? {};

  const options: ConnectConfig = {
    host: config.host,
    port: config.port ?? 22,
    username: user,
    readyTimeout: 10_000,
  };

  // Explicit credentials win: keyPath/password auth, else ssh-agent (the
  // vscode-sshfs default). Mixing agent + password makes ssh2 attempt the
  // agent first and fail confusingly when it holds no matching key.
  if (config.keyPath) {
    const path = config.keyPath.replace(/^~(?=\/|$)/, process.env.HOME ?? "");
    if (!existsSync(path)) throw new Error(`Private key not found: ${config.keyPath}`);
    options.privateKey = readFileSync(path);
    if (secret.passphrase) options.passphrase = secret.passphrase;
  } else if (secret.password) {
    options.password = secret.password;
  } else {
    options.agent = process.env.SSH_AUTH_SOCK;
  }
  return options;
}

/** Validate a full config list; throws with a readable first problem. */
export function validateConfigs(configs: unknown): SshFsConfig[] {
  const parsed = configSchema.array().safeParse(configs);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length
      ? `configs${issue.path
          .map((part) => {
            if (typeof part === "number") return `[${part}]`;
            return typeof part === "string" ? `.${part}` : "";
          })
          .join("")}`
      : "configs";
    const suffix = parsed.error.issues.length > 1 ? ` (and ${parsed.error.issues.length - 1} more)` : "";
    throw new Error(`${where}: ${issue?.message ?? "invalid config"}${suffix}`);
  }
  const seen = new Set<string>();
  for (const config of parsed.data) {
    if (seen.has(config.name)) throw new Error(`Duplicate config name "${config.name}"`);
    seen.add(config.name);
  }
  return parsed.data;
}

/** Parse the secret JSON setting into a typed map. */
export function parseSecrets(raw: string | undefined): ConfigSecrets {
  if (!raw || raw.trim() === "") return {};
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("The secrets setting must be a JSON object");
  }
  const parsed = secretsSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `Invalid secrets: ${parsed.error.issues[0]?.message ?? "bad JSON shape"}`,
    );
  }
  return parsed.data;
}

/** Normalize a saved config list: default root, stripped empties, stable order. */
export function normalizeConfigs(configs: SshFsConfig[]): SshFsConfig[] {
  return configs.map((config) => ({
    ...config,
    user: config.user?.trim() || undefined,
    port: config.port,
    root: normalizeRoot(config.root),
    keyPath: config.keyPath?.trim() || undefined,
  }));
}