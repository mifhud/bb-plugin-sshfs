// Remote directory browser: breadcrumb navigation, dir listing, row
// actions (open, rename, delete), a name filter, and a right-click context
// menu with the create tools (new file / new folder).
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { experimental_useAppPanel, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../server";
import type { ConfigView, FsEntry } from "../contract";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuPortal,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { ConfirmDialog } from "./confirm-dialog";
import { clearDirtyDraft, getDirtyDraft } from "./draft-store";
import { errorMessage, formatBytes, formatMtime, joinRel, parentRel, segmentsRel } from "./utils";

function EntryIcon({ kind, className }: { kind: FsEntry["kind"]; className?: string }) {
  const name = kind === "dir" ? "FolderOpen" : kind === "link" ? "Link" : "FileText";
  return <Icon name={name} className={cn("size-4 shrink-0 text-muted-foreground", className)} />;
}

/** A small labeled-input dialog used for new file / new folder / rename. */
function NameDialog({
  open,
  title,
  description,
  initial,
  placeholder,
  confirmLabel,
  busy,
  error,
  onSubmit,
  onClose,
}: {
  open: boolean;
  title: string;
  description?: string;
  initial: string;
  placeholder: string;
  confirmLabel: string;
  busy: boolean;
  error: string | null;
  onSubmit: (value: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initial);
  useEffect(() => {
    if (open) setValue(initial);
  }, [open, initial]);
  const clean = value.trim();
  const invalid =
    clean === "" || clean === "." || clean === ".." || clean.includes("/");
  const submit = () => {
    if (invalid) return;
    onSubmit(clean);
  };
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="w-full max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description === undefined ? null : <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <Input
          autoFocus
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") submit();
          }}
          placeholder={placeholder}
          aria-label={title}
        />
        {error === null ? null : <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy || invalid}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type BrowserDialog =
  | { kind: "file" }
  | { kind: "folder" }
  | { kind: "rename"; entry: FsEntry };

export function RemoteBrowser({
  config,
  initialPath = "",
  onCwdChange,
}: {
  /** Must be connected to browse (the page only mounts it when connected). */
  config: ConfigView;
  /** Directory to land on at mount (restored from the session store). */
  initialPath?: string;
  onCwdChange?: (cwd: string) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const panel = experimental_useAppPanel();

  type SortKey = "name" | "size" | "mtimeMs";
  type SortDir = "asc" | "desc";
  const sortLabel: Record<SortKey, string> = {
    name: "Name",
    size: "Size",
    mtimeMs: "Last modified",
  };
  const [sortKey, setSortKey] = useState<SortKey>(() => {
    try {
      const value = window.localStorage.getItem("sshfs:sortKey");
      if (value === "name" || value === "size" || value === "mtimeMs") return value;
    } catch {
      // storage unavailable: keep the default
    }
    return "name";
  });
  const [sortDir, setSortDir] = useState<SortDir>(() => {
    try {
      const value = window.localStorage.getItem("sshfs:sortDir");
      if (value === "asc" || value === "desc") return value;
    } catch {
      // storage unavailable: keep the default
    }
    return "asc";
  });
  const toggleSort = (key: SortKey) => {
    if (key === sortKey) {
      const next = sortDir === "asc" ? "desc" : "asc";
      setSortDir(next);
      try {
        window.localStorage.setItem("sshfs:sortDir", next);
      } catch {
        // storage unavailable: sort persists for the session only
      }
      return;
    }
    const initial: SortDir = key === "mtimeMs" ? "desc" : "asc";
    setSortKey(key);
    setSortDir(initial);
    try {
      window.localStorage.setItem("sshfs:sortKey", key);
      window.localStorage.setItem("sshfs:sortDir", initial);
    } catch {
      // storage unavailable: sort persists for the session only
    }
  };

  const [cwd, setCwd] = useState(initialPath ?? "");
  const [entries, setEntries] = useState<FsEntry[] | null>(null);
  const [filter, setFilter] = useState("");
  const filterQuery = filter.trim().toLowerCase();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const cache = useRef(new Map<string, { entries: FsEntry[]; truncated: boolean }>());
  const firstCwdLoad = useRef(true);

  // In-place folder expansion (chevron) vs. row click (navigate): expanded
  // dirs are keyed root-relative so they survive breadcrumb navigation.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [children, setChildren] = useState<Record<string, { entries: FsEntry[] | null; error: string | null }>>({});
  const childrenCache = useRef(new Map<string, FsEntry[]>());
  const childrenLoading = useRef(new Set<string>());

  const [dialog, setDialog] = useState<BrowserDialog | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [dialogBusy, setDialogBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<FsEntry | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingOpen, setPendingOpen] = useState<{
    mount: string;
    path: string;
    name: string;
  } | null>(null);

  /** Folder path to create a new file/folder *in*, set by right-clicking an
   * entry. Null means right-click hit empty space — create in `cwd` instead. */
  const [contextFolder, setContextFolder] = useState<string | null>(null);

  const renameTarget =
    dialog !== null && dialog.kind === "rename" ? dialog.entry : null;
  const mount = config.name;

  const navigate = (path: string) => {
    setCwd(path);
    onCwdChange?.(path);
  };

  const load = useCallback(
    async (path: string, force = false) => {
      const cached = cache.current.get(path);
      if (cached !== undefined && !force) {
        setEntries(cached.entries);
        setTruncated(cached.truncated);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const result = await rpc.call("fs_list", { mount, path: path === "" ? "." : path });
        cache.current.set(path, { entries: result.entries, truncated: result.truncated });
        setEntries(result.entries);
        setTruncated(result.truncated);
      } catch (cause) {
        setError(errorMessage(cause));
        setEntries(null);
        cache.current.delete(path);
      } finally {
        setLoading(false);
      }
    },
    [rpc, mount],
  );

  // Fresh state per mount: reset the cache and load the (restored) directory.
  useEffect(() => {
    cache.current = new Map();
    childrenCache.current.clear();
    childrenLoading.current.clear();
    setChildren({});
    setExpanded(new Set());
    void load(cwd);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-scoped: cwd is the initialPath at mount
  }, [mount, load]);

  // Navigate on breadcrumb/dir clicks; the mount initial load happens above.
  useEffect(() => {
    if (firstCwdLoad.current) {
      firstCwdLoad.current = false;
      return;
    }
    void load(cwd);
  }, [cwd, load]);

  const openTab = (mount: string, path: string, name: string) => {
    panel.experimental_openTab({
      surface: { kind: "current" },
      tab: { id: "editor", context: { kind: "nav-panel", panelId: "sshfs" }, availability: "action" },
      params: { mount, path },
      title: name,
    });
  };

  const openFile = (path: string, name: string) => {
    // Reopening a file that still has an unsaved draft asks what to do with
    // it instead of silently restoring or silently discarding it.
    if (getDirtyDraft(mount, path) !== undefined) {
      setPendingOpen({ mount, path, name });
      return;
    }
    openTab(mount, path, name);
  };

  const keepDraftAndOpen = () => {
    if (pendingOpen === null) return;
    const { mount: m, path: p, name: n } = pendingOpen;
    setPendingOpen(null);
    openTab(m, p, n);
  };

  const discardDraftAndOpen = () => {
    if (pendingOpen === null) return;
    const { mount: m, path: p, name: n } = pendingOpen;
    clearDirtyDraft(m, p);
    setPendingOpen(null);
    openTab(m, p, n);
  };

  /** Fetch a folder's children once for in-place expansion. */
  const loadChildren = useCallback(
    (path: string) => {
      if (childrenCache.current.has(path) || childrenLoading.current.has(path)) return;
      setChildren((prev) => ({ ...prev, [path]: { entries: null, error: null } }));
      childrenLoading.current.add(path);
      void (async () => {
        try {
          const result = await rpc.call("fs_list", { mount, path: path === "" ? "." : path });
          childrenCache.current.set(path, result.entries);
          setChildren((prev) => ({ ...prev, [path]: { entries: result.entries, error: null } }));
        } catch (cause) {
          setChildren((prev) => ({ ...prev, [path]: { entries: null, error: errorMessage(cause) } }));
        } finally {
          childrenLoading.current.delete(path);
        }
      })();
    },
    [rpc, mount],
  );

  const toggleExpand = (path: string) => {
    if (!expanded.has(path)) loadChildren(path);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const invalidate = useCallback(() => {
    cache.current.clear();
    childrenCache.current.clear();
    setChildren({});
    for (const path of expanded) loadChildren(path);
    void load(cwd, true);
  }, [cwd, load, expanded, loadChildren]);

  const createEntry = async (value: string, kind: "file" | "folder") => {
    setDialogBusy(true);
    setDialogError(null);
    try {
      const parent = contextFolder ?? cwd;
      const path = joinRel(parent, value);
      if (kind === "folder") {
        await rpc.call("fs_mkdir", { mount, path });
      } else {
        const exists = entries?.some((entry) => entry.name === value) ?? false;
        if (exists) throw new Error(`"${value}" already exists here`);
        await rpc.call("fs_write", { mount, path, content: "" });
      }
      toast.success(kind === "folder" ? `Created folder ${value}` : `Created ${value}`);
      setDialog(null);
      invalidate();
    } catch (cause) {
      setDialogError(errorMessage(cause));
    } finally {
      setDialogBusy(false);
    }
  };

  const renameEntry = async (value: string) => {
    if (renameTarget === null) return;
    setDialogBusy(true);
    setDialogError(null);
    try {
      await rpc.call("fs_rename", {
        mount,
        from: joinRel(cwd, renameTarget.name),
        to: joinRel(cwd, value),
      });
      toast.success(`Renamed to ${value}`);
      setDialog(null);
      invalidate();
    } catch (cause) {
      setDialogError(errorMessage(cause));
    } finally {
      setDialogBusy(false);
    }
  };

  const deleteEntry = async () => {
    if (confirmDelete === null) return;
    const entry = confirmDelete;
    setBusy(true);
    try {
      await rpc.call("fs_delete", { mount, path: joinRel(cwd, entry.name) });
      toast.success(`Deleted ${entry.name}`);
      invalidate();
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setBusy(false);
      setConfirmDelete(null);
    }
  };

  if (!config.connected) {
    return null; // the page renders the pick-a-mount hint instead
  }

  const crumbs = segmentsRel(cwd);

  // Directory the create menu will target: a right-clicked folder/file, or
  // the current directory when the click hit empty space.
  const createParent = contextFolder ?? cwd;
  const createParentLabel = createParent === "" ? "/" : createParent;

  // Recursive row builder: expanded dirs render their children inline under
  // the row (indented); rename/delete stay on top-level rows only. The name
  // filter hides entries (files and folders alike) whose name doesn't match.
  const listingRows: ReactNode[] = [];
  const buildRows = (dirEntries: FsEntry[], dirPath: string, depth: number) => {
    const visible = filterQuery === "" ? dirEntries : dirEntries.filter((e) => e.name.toLowerCase().includes(filterQuery));
    const factor = sortDir === "asc" ? 1 : -1;
    const sorted = [...visible].sort((a, b) => {
      const compare =
        sortKey === "name"
          ? a.name.localeCompare(b.name)
          : sortKey === "size"
            ? (a.size - b.size) || a.name.localeCompare(b.name)
            : (a.mtimeMs ?? -1) - (b.mtimeMs ?? -1) || a.name.localeCompare(b.name);
      return compare * factor;
    });
    for (const entry of sorted) {
      const path = joinRel(dirPath, entry.name);
      const isDir = entry.kind === "dir";
      const isOpen = isDir && expanded.has(path);
      const child = children[path];
      listingRows.push(
        <li
          key={path}
          className="group flex items-center gap-2 py-2 pr-3"
          style={{ paddingLeft: 12 + depth * 16 }}
        >
          {isDir ? (
            <button
              type="button"
              className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-state-hover"
              aria-label={isOpen ? `Collapse ${entry.name}` : `Expand ${entry.name}`}
              onClick={() => toggleExpand(path)}
            >
              <Icon
                name="ChevronRight"
                className={cn("size-4 transition-transform", isOpen && "rotate-90")}
              />
            </button>
          ) : (
            <span className="size-6 shrink-0" />
          )}
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm"
            onClick={() => {
              if (isDir) navigate(path);
              else openFile(path, entry.name);
            }}
            onContextMenu={() => {
              // Right-click on a folder → create inside it; on a file → parent dir.
              setContextFolder(isDir ? path : parentRel(path));
            }}
            title={isDir ? `Open ${entry.name}` : `Edit ${entry.name}`}
          >
            <EntryIcon kind={entry.kind} />
            <span className="truncate">{entry.name}</span>
          </button>
          <span className="hidden w-20 shrink-0 text-right font-mono text-xs text-muted-foreground sm:block">
            {isDir ? "" : formatBytes(entry.size)}
          </span>
          <span className="hidden w-24 shrink-0 text-right text-xs text-muted-foreground md:block">
            {formatMtime(entry.mtimeMs)}
          </span>
          {depth === 0 ? (
            <div className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                aria-label="Rename"
                onClick={() => {
                  setDialogError(null);
                  setDialog({ kind: "rename", entry });
                }}
              >
                <Icon name="EditFile" className="size-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 text-muted-foreground hover:text-destructive"
                aria-label="Delete"
                onClick={() => setConfirmDelete(entry)}
              >
                <Icon name="Trash2" className="size-3.5" />
              </Button>
            </div>
          ) : null}
        </li>,
      );
      if (!isOpen) continue;
      if (child === undefined || (child.entries === null && child.error === null)) {
        listingRows.push(
          <li
            key={`${path}:loading`}
            className="py-2 pr-3 text-xs text-muted-foreground"
            style={{ paddingLeft: 12 + (depth + 1) * 16 }}
          >
            Loading {path}…
          </li>,
        );
      } else if (child.error !== null) {
        listingRows.push(
          <li
            key={`${path}:error`}
            className="py-2 pr-3 text-xs text-destructive"
            style={{ paddingLeft: 12 + (depth + 1) * 16 }}
          >
            {child.error}
          </li>,
        );
      } else if (child.entries !== null && child.entries.length === 0) {
        listingRows.push(
          <li
            key={`${path}:empty`}
            className="py-2 pr-3 text-xs text-muted-foreground"
            style={{ paddingLeft: 12 + (depth + 1) * 16 }}
          >
            Empty
          </li>,
        );
      } else if (child.entries !== null) {
        buildRows(child.entries, path, depth + 1);
      }
    }
  };
  if (entries !== null) buildRows(entries, cwd, 0);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Path dir — full-width row, then tools on their own row */}
      <div className="border-b border-border">
        <div className="flex items-center gap-1 px-3 py-1.5">
          <Button
            variant="ghost"
            size="sm"
            className={cn("h-7 px-1.5 text-xs", cwd === "" && "text-foreground")}
            onClick={() => navigate("")}
            aria-label="Mount root"
          >
            <Icon name="Terminal" className="mr-1 size-3.5" />
            {mount}
          </Button>
          {crumbs.map((segment, index) => {
            const path = crumbs.slice(0, index + 1).join("/");
            const last = index === crumbs.length - 1;
            return (
              <span key={path} className="flex min-w-0 items-center gap-1">
                <span className="text-muted-foreground">/</span>
                <Button
                  variant="ghost"
                  size="sm"
                  className={cn("h-7 px-1.5 text-xs", last && "text-foreground")}
                  onClick={() => navigate(path)}
                >
                  <span className="max-w-32 truncate">{segment}</span>
                </Button>
              </span>
            );
          })}
        </div>
        <div className="flex items-center gap-1.5 border-t border-border px-3 py-1.5">
          <div className="relative min-w-0 flex-1">
            <Input
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Filter files and folders…"
              aria-label="Filter by name"
              className="h-7 pr-7 text-xs"
            />
            {filter === "" ? null : (
              <button
                type="button"
                aria-label="Clear filter"
                className="absolute right-1 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-state-hover hover:text-foreground"
                onClick={() => setFilter("")}
              >
                <Icon name="X" className="size-3" />
              </button>
            )}
          </div>
          <Button variant="ghost" size="icon" className="size-7" aria-label="Refresh" onClick={invalidate}>
            <Icon name="ArrowReloadHorizontal" className="size-3.5" />
          </Button>
        </div>
      </div>

      {/* Listing — right-click anywhere (rows, headers, empty space) opens
          the create menu: new file / new folder. Right-clicking a folder
          entry creates inside that folder instead of the current directory. */}
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            className="min-h-0 flex-1 overflow-y-auto p-2"
            onContextMenuCapture={() => setContextFolder(null)}
          >
            {loading && entries === null ? (
              <p className="px-2 py-6 text-center text-sm text-muted-foreground">
                Loading {cwd === "" ? "/" : cwd}…
              </p>
            ) : error !== null ? (
              <div className="space-y-2 px-2 py-6 text-center">
                <p className="text-sm text-destructive">{error}</p>
                <Button variant="outline" size="sm" onClick={() => void load(cwd, true)}>
                  Retry
                </Button>
              </div>
            ) : entries !== null && entries.length === 0 ? (
              <p className="px-2 py-6 text-center text-sm text-muted-foreground">Empty directory</p>
            ) : entries !== null && listingRows.length === 0 ? (
              <p className="px-2 py-6 text-center text-sm text-muted-foreground">
                No matches for "{filter}"
              </p>
            ) : (
              <>
                <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
                  <li className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium text-muted-foreground">
                    <span className="size-6 shrink-0" />
                    {(["name", "size", "mtimeMs"] as const).map((key) => (
                      <button
                        key={key}
                        type="button"
                        className={cn(
                          "font-medium hover:text-foreground",
                          key === "name" && "flex min-w-0 flex-1 items-center gap-1 text-left",
                          key === "size" && "hidden w-20 shrink-0 text-right sm:block",
                          key === "mtimeMs" && "hidden w-24 shrink-0 text-right md:block",
                          sortKey === key && "text-foreground",
                        )}
                        onClick={() => toggleSort(key)}
                        aria-label={`Sort by ${sortLabel[key].toLowerCase()}`}
                      >
                        {sortLabel[key]}
                        {sortKey === key ? (sortDir === "asc" ? " ↑" : " ↓") : null}
                      </button>
                    ))}
                  </li>
                  {listingRows}
                </ul>
                {truncated ? (
                  <p className="mt-2 text-center text-xs text-muted-foreground">
                    List truncated (2000 entries shown)
                  </p>
                ) : null}
              </>
            )}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={() => setDialog({ kind: "file" })}>
            New file
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => setDialog({ kind: "folder" })}>
            New folder
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {/* Dialogs */}
      <NameDialog
        open={dialog !== null && dialog.kind === "file"}
        title="New file"
        description={`In ${createParentLabel}`}
        initial=""
        placeholder="file.txt"
        confirmLabel="Create"
        busy={dialogBusy}
        error={dialogError}
        onSubmit={(value) => void createEntry(value, "file")}
        onClose={() => { setDialog(null); setContextFolder(null); }}
      />
      <NameDialog
        open={dialog !== null && dialog.kind === "folder"}
        title="New folder"
        description={`In ${createParentLabel}`}
        initial=""
        placeholder="folder"
        confirmLabel="Create"
        busy={dialogBusy}
        error={dialogError}
        onSubmit={(value) => void createEntry(value, "folder")}
        onClose={() => { setDialog(null); setContextFolder(null); }}
      />
      <NameDialog
        open={renameTarget !== null}
        title="Rename"
        initial={renameTarget?.name ?? ""}
        placeholder="new-name"
        confirmLabel="Rename"
        busy={dialogBusy}
        error={dialogError}
        onSubmit={(value) => void renameEntry(value)}
        onClose={() => setDialog(null)}
      />
      <ConfirmDialog
        open={pendingOpen !== null}
        title="Unsaved draft"
        description={
          pendingOpen === null ? undefined : (
            <>
              <span className="font-mono">{pendingOpen.path}</span> has an
              unsaved draft. Keep editing the draft, or discard it and reload
              from the server?
            </>
          )
        }
        confirmLabel="Discard"
        extraAction={{ label: "Keep draft", onClick: keepDraftAndOpen }}
        onConfirm={discardDraftAndOpen}
        onClose={() => setPendingOpen(null)}
      />
      <ConfirmDialog
        open={confirmDelete !== null}
        title={`Delete ${confirmDelete?.name ?? ""}?`}
        description={
          confirmDelete !== null && confirmDelete.kind === "dir"
            ? "The whole directory and its contents will be deleted remotely. This cannot be undone."
            : "This file will be deleted remotely. This cannot be undone."
        }
        confirmLabel="Delete"
        onConfirm={() => void deleteEntry()}
        onClose={() => setConfirmDelete(null)}
      />
    </div>
  );
}