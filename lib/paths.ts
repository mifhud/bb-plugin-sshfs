// Remote POSIX path helpers shared by the server and tests.
//
// Every path a caller names is relative to the mount root (like
// vscode-sshfs's `Root` field): "src/app.tsx" resolves to "<root>/src/app.tsx".
// Traversal is refused outright — a relative path must never escape root.

/** Thrown for any path that would leave the mount root. */
export class PathConfinementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathConfinementError";
  }
}

/**
 * Normalize a configured root: absolute or `~`-prefixed, collapsed, no
 * trailing slash (except "/"). `~` is expanded to the remote home during
 * connect (POSIX servers).
 */
export function normalizeRoot(raw: string | undefined): string {
  const trimmed = raw === undefined || raw.trim() === "" ? "/" : raw.trim().replace(/\/+$/, "");
  if (trimmed === "~") return "~";
  if (trimmed.startsWith("~/")) {
    const parts = trimmed.slice(1).split("/").filter((part) => part !== "");
    return parts.length === 0 ? "~" : `~/${parts.join("/")}`;
  }
  const absolute = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  const parts = absolute.split("/").filter((part) => part !== "");
  return parts.length === 0 ? "/" : `/${parts.join("/")}`;
}

/**
 * Resolve a root-relative POSIX path against the mount root.
 * `rel` must be relative (no leading "/"), non-empty, and free of `..`
 * segments and NUL bytes. `"."`/`"./"` mean the root itself.
 */
export function resolveRemote(root: string, rel: string): string {
  if (rel.length === 0) throw new PathConfinementError("Path is empty");
  if (rel.includes("\x00")) throw new PathConfinementError("Path contains NUL bytes");
  if (rel.includes("\\")) throw new PathConfinementError("Use forward slashes in paths");
  if (rel.startsWith("/")) {
    throw new PathConfinementError(`Path must be relative to the mount root: ${rel}`);
  }
  const segments = rel.split("/").filter((segment) => segment !== "" && segment !== ".");
  for (const segment of segments) {
    if (segment === "..") throw new PathConfinementError("Path escapes the mount root");
    if (segment.length > 255) throw new PathConfinementError("Path segment too long");
  }
  if (segments.length === 0) return root;
  return `${root === "/" ? "" : root}/${segments.join("/")}`;
}

/** POSIX file type bits (stat(2) S_IFMT). */
const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;

/** Map an SFTP mode to a display kind. Mode may be absent on some servers. */
export function kindFromMode(mode: number | null | undefined): "dir" | "file" | "link" | "other" {
  if (mode === null || mode === undefined || mode === 0) return "file";
  const type = mode & S_IFMT;
  if (type === S_IFDIR) return "dir";
  if (type === S_IFREG) return "file";
  if (type === S_IFLNK) return "link";
  return "other";
}

/** Sort entries the way a file explorer does: directories first, then names. */
export function sortEntries<T extends { kind: string; name: string }>(entries: T[]): T[] {
  return [...entries].sort((a, b) => {
    const aDir = a.kind === "dir" ? 0 : 1;
    const bDir = b.kind === "dir" ? 0 : 1;
    if (aDir !== bDir) return aDir - bDir;
    return a.name.localeCompare(b.name, "en", { sensitivity: "base" });
  });
}

/** Detect a file that is not safely editable as UTF-8 text. */
export function isBinaryBuffer(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, 8192);
  if (sample.includes(0)) return true;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(sample);
    return false;
  } catch {
    return true;
  }
}