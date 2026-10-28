// Frontend-only mount session memory. Survives the SSH FS page unmounting
// (navigating to Home and back, switching navigation panels) within the app
// session: it records where each mount was last browsed and when it was last
// connected, so the page can restore that state on return. The server owns
// the real SSH connections; this store only feeds the UI decisions.
//
// Manual disconnects end a mount's session (lastConnectedAt -> null) but keep
// the remembered directory, so a later manual reconnect lands where the user
// left off.
export interface MountSession {
  cwd: string;
  lastConnectedAt: number | null;
}

const sessions = new Map<string, MountSession>();
let lastSelectedMount: string | null = null;

export function getMountSession(mount: string): MountSession | undefined {
  return sessions.get(mount);
}

export function getMountCwd(mount: string): string {
  return sessions.get(mount)?.cwd ?? "";
}

export function setMountCwd(mount: string, cwd: string): void {
  const session = sessions.get(mount) ?? { cwd: "", lastConnectedAt: null };
  session.cwd = cwd;
  sessions.set(mount, session);
}

export function markMountConnected(mount: string): void {
  const session = sessions.get(mount) ?? { cwd: "", lastConnectedAt: null };
  session.lastConnectedAt = Date.now();
  sessions.set(mount, session);
}

export function markMountDisconnected(mount: string): void {
  const session = sessions.get(mount);
  if (session === undefined) sessions.set(mount, { cwd: "", lastConnectedAt: null });
  else session.lastConnectedAt = null;
}

export function getLastSelectedMount(): string | null {
  return lastSelectedMount;
}

export function setLastSelectedMount(mount: string | null): void {
  lastSelectedMount = mount;
}

/**
 * Forget remembered directories whose session window elapsed while the mount
 * was disconnected. A live connection keeps its directory (that is current
 * state, not memory) and a manual disconnect keeps it too (reconnecting lands
 * where the user left off); only a session that ended implicitly and aged past
 * the window is dropped. `rememberSeconds <= 0` (off) drops every
 * disconnected session.
 */
export function expireStaleSessions(
  configs: readonly { name: string; connected: boolean }[],
  rememberSeconds: number,
  now: number = Date.now(),
): void {
  const cutoff = rememberSeconds > 0 ? now - rememberSeconds * 1000 : Number.POSITIVE_INFINITY;
  for (const config of configs) {
    if (config.connected) continue;
    const session = sessions.get(config.name);
    if (session === undefined || session.lastConnectedAt === null) continue;
    if (session.lastConnectedAt >= cutoff) continue;
    sessions.delete(config.name);
  }
}

/** Test hook: wipe all remembered state (also used on app teardown if ever needed). */
export function resetSessionStore(): void {
  sessions.clear();
  lastSelectedMount = null;
}