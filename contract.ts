// bb-plugin-sshfs — shared RPC contract and config schemas.
//
// Schemas run at the wire boundary. Handler input/output are inferred from
// the shared contract; app.tsx imports only its type.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

// -- SSH FS configs ----------------------------------------------------------
//
// Mirrors vscode-sshfs configs minus the VS Code shell: each config names an
// SSH target and the remote root directory it mounts. `host` accepts
// `user@host`; `user`/`port`/`keyPath` override or fill the rest. Root-relative
// paths in every other call are resolved against `root` on the server.

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const POSIX_PATH_PATTERN = /^[^\x00\n]*$/;

export const configSchema = z
  .object({
    name: z
      .string()
      .regex(NAME_PATTERN, "Name must be lowercase letters, digits, or dashes"),
    host: z
      .string()
      .min(1, "Host is required")
      .max(255)
      .regex(/^[^\s@]+(@[^\s/]+)?$/, "Host must be `host` or `user@host`"),
    user: z.string().min(1).max(128).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    root: z
      .string()
      .max(1024)
      .regex(POSIX_PATH_PATTERN, "Root must be a POSIX path")
      .optional(),
    keyPath: z
      .string()
      .min(1)
      .max(1024)
      .regex(POSIX_PATH_PATTERN, "keyPath must be a local file path")
      .optional(),
  })
  .strict();

export type SshFsConfig = z.infer<typeof configSchema>;

/** Secrets live server-side only (secret setting); never in configs. */
export const secretsSchema = z
  .record(
    z.string().regex(NAME_PATTERN),
    z
      .object({
        password: z.string().max(512).optional(),
        passphrase: z.string().max(512).optional(),
      })
      .strict(),
  )
  .default({});

export type ConfigSecrets = z.infer<typeof secretsSchema>;

/** Config as the frontend sees it: auth facts stripped. */
export const configViewSchema = configSchema.extend({
  connected: z.boolean(),
});

export type ConfigView = z.infer<typeof configViewSchema>;

// -- Remote file system DTOs -------------------------------------------------

export const fsKindSchema = z.enum(["dir", "file", "link", "other"]);

export const fsEntrySchema = z.object({
  name: z.string().max(1024),
  kind: fsKindSchema,
  size: z.number().int().min(0),
  mtimeMs: z.number().int().min(0).nullable(),
  mode: z.number().int().min(0).nullable(),
});

export type FsEntry = z.infer<typeof fsEntrySchema>;

/** Maximum size of a file read over RPC/CLI (bytes). */
export const MAX_FILE_BYTES = 4 * 1024 * 1024;
/** Maximum characters of text written in one call. */
export const MAX_WRITE_CHARS = 2 * 1024 * 1024;
/** Columns of the CLI `ls` table. */
export const CLI_LIST_MAX_ENTRIES = 2000;

// -- RPC contract ------------------------------------------------------------

export const rpcContract = defineRpcContract({
  /** Full config list with live connection state. */
  configs_list: {
    input: z.null(),
    output: z.object({ configs: z.array(configViewSchema) }),
  },
  /** Replace the whole config list (add/rename/delete). */
  configs_save: {
    input: z.object({ configs: z.array(configSchema).max(64) }),
    output: z.object({ configs: z.array(configViewSchema) }),
  },
  mounts_connect: {
    input: z.object({ name: z.string().regex(NAME_PATTERN) }),
    output: z.object({
      connected: z.boolean(),
      root: z.string(),
      user: z.string(),
      host: z.string(),
      port: z.number().int().min(1).max(65535),
    }),
  },
  mounts_disconnect: {
    input: z.object({ name: z.string().regex(NAME_PATTERN) }),
    output: z.object({ disconnected: z.boolean() }),
  },
  fs_list: {
    input: z.object({ mount: z.string().regex(NAME_PATTERN), path: z.string().min(1).max(4096) }),
    output: z.object({
      path: z.string(),
      entries: z.array(fsEntrySchema),
      truncated: z.boolean(),
    }),
  },
  fs_read: {
    input: z.object({ mount: z.string().regex(NAME_PATTERN), path: z.string().min(1).max(4096) }),
    output: z.object({
      path: z.string(),
      content: z.string(),
      size: z.number().int().min(0),
      mtimeMs: z.number().int().min(0).nullable(),
      isBinary: z.boolean(),
    }),
  },
  fs_write: {
    input: z.object({
      mount: z.string().regex(NAME_PATTERN),
      path: z.string().min(1).max(4096),
      content: z.string().max(MAX_WRITE_CHARS),
    }),
    output: z.object({ size: z.number().int().min(0), mtimeMs: z.number().int().min(0).nullable() }),
  },
  fs_mkdir: {
    input: z.object({ mount: z.string().regex(NAME_PATTERN), path: z.string().min(1).max(4096) }),
    output: z.object({ created: z.boolean() }),
  },
  fs_delete: {
    input: z.object({ mount: z.string().regex(NAME_PATTERN), path: z.string().min(1).max(4096) }),
    output: z.object({ removed: z.boolean() }),
  },
  fs_rename: {
    input: z.object({
      mount: z.string().regex(NAME_PATTERN),
      from: z.string().min(1).max(4096),
      to: z.string().min(1).max(4096),
    }),
    output: z.object({ renamed: z.boolean() }),
  },
});