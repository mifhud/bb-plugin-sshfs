// Frontend path/format helpers (mirror lib/paths.ts semantics: relative POSIX).
export function joinRel(base: string, name: string): string {
  return base === "" ? name : `${base}/${name}`;
}

export function parentRel(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
}

export function baseName(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? path : path.slice(index + 1);
}

export function segmentsRel(path: string): string[] {
  return path === "" ? [] : path.split("/");
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = size;
  let unit = "";
  for (const next of units) {
    if (value < 1024) break;
    value /= 1024;
    unit = next;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${unit}`;
}

export function formatMtime(mtimeMs: number | null): string {
  if (mtimeMs === null) return "";
  const date = new Date(mtimeMs);
  const now = new Date();
  const sameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? { hour: "2-digit", minute: "2-digit" } : { year: "numeric" }),
  });
}

/** Untrusted RPC/params payloads: narrow to what we accept. */
export function parseMountPath(
  params: unknown,
): { mount: string; path: string } | null {
  if (params === null || typeof params !== "object") return null;
  const candidate = params as Record<string, unknown>;
  if (
    typeof candidate.mount !== "string" ||
    typeof candidate.path !== "string" ||
    candidate.mount === "" ||
    candidate.path === ""
  ) {
    return null;
  }
  return { mount: candidate.mount, path: candidate.path };
}

/** Extract a readable message from an unknown thrown error. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}