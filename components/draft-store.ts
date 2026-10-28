// Frontend-only unsaved-edit memory, keyed by `mount:path`.
//
// The editor tab persists every keystroke here and restores it on remount,
// so switching editor tabs (or leaving the panel) never discards unsaved
// changes silently. The browser consults it before opening another file
// while a draft is dirty and offers save / discard / cancel. The server owns
// the real files; this store only keeps the user's uncommitted edits alive
// for the app session.
export interface DirtyDraft {
  mount: string;
  path: string;
  content: string;
}

const drafts = new Map<string, DirtyDraft>();

function key(mount: string, path: string): string {
  return `${mount}:${path}`;
}

export function getDirtyDraft(mount: string, path: string): DirtyDraft | undefined {
  return drafts.get(key(mount, path));
}

export function setDirtyDraft(draft: DirtyDraft): void {
  drafts.set(key(draft.mount, draft.path), draft);
}

export function clearDirtyDraft(mount: string, path: string): void {
  drafts.delete(key(mount, path));
}

/**
 * The most recently stored dirty draft on `mount` that is not `path` itself.
 * Used by the browser: opening a different file while a draft is dirty asks
 * whether to save it first.
 */
export function findOtherDirtyDraft(mount: string, path: string): DirtyDraft | undefined {
  for (const draft of drafts.values()) {
    if (draft.mount === mount && draft.path !== path) return draft;
  }
  return undefined;
}

/** Test hook: wipe all remembered drafts. */
export function resetDraftStore(): void {
  drafts.clear();
}