// Remote directory browser: breadcrumb navigation, dir listing, and row
// actions (open, rename, delete) plus new-file/new-folder/refresh tools.
import { useCallback, useEffect, useRef, useState } from "react";
import { experimental_useAppPanel, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../server";
import type { ConfigView, FsEntry } from "../contract";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { ConfirmDialog } from "./confirm-dialog";
import { errorMessage, formatBytes, formatMtime, joinRel, segmentsRel } from "./utils";

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

  const [cwd, setCwd] = useState(initialPath ?? "");
  const [entries, setEntries] = useState<FsEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const cache = useRef(new Map<string, { entries: FsEntry[]; truncated: boolean }>());
  const firstCwdLoad = useRef(true);

  const [dialog, setDialog] = useState<BrowserDialog | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [dialogBusy, setDialogBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<FsEntry | null>(null);
  const [busy, setBusy] = useState(false);

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

  const invalidate = useCallback(() => {
    cache.current.clear();
    void load(cwd, true);
  }, [cwd, load]);

  const openFile = (entry: FsEntry) => {
    panel.experimental_openTab({
      surface: { kind: "current" },
      tab: { id: "editor", context: { kind: "nav-panel", panelId: "sshfs" }, availability: "action" },
      params: { mount, path: joinRel(cwd, entry.name) },
      title: entry.name,
    });
  };

  const createEntry = async (value: string, kind: "file" | "folder") => {
    setDialogBusy(true);
    setDialogError(null);
    try {
      const path = joinRel(cwd, value);
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

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Breadcrumb + tools */}
      <div className="flex items-center gap-1 border-b border-border px-3 py-2">
        <Button
          variant="ghost"
          size="sm"
          className={cn("h-7 px-1.5 text-xs", cwd === "" && "text-foreground")}
          onClick={() => navigate("")}
          aria-label="Mount root"
        >
          <Icon name="Globe" className="mr-1 size-3.5" />
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
        <span className="ml-auto flex items-center gap-1">
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setDialog({ kind: "file" })}>
            <Icon name="Plus" className="mr-1 size-3.5" />
            New file
          </Button>
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setDialog({ kind: "folder" })}>
            <Icon name="FolderOpen" className="mr-1 size-3.5" />
            New folder
          </Button>
          <Button variant="ghost" size="icon" className="size-7" aria-label="Refresh" onClick={invalidate}>
            <Icon name="ArrowReloadHorizontal" className="size-3.5" />
          </Button>
        </span>
      </div>

      {/* Listing */}
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
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
        ) : (
          <>
            <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
              {entries?.map((entry) => {
                const isDir = entry.kind === "dir";
                return (
                  <li key={entry.name} className="group flex items-center gap-2 px-3 py-2">
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm"
                      onClick={() => {
                        if (isDir) navigate(joinRel(cwd, entry.name));
                        else openFile(entry);
                      }}
                      title={isDir ? `Open ${entry.name}` : `Edit ${entry.name}`}
                    >
                      {isDir ? (
                        <Icon name="ChevronRight" className="size-4 shrink-0 text-muted-foreground" />
                      ) : (
                        <span className="w-4 shrink-0" />
                      )}
                      <EntryIcon kind={entry.kind} />
                      <span className="truncate">{entry.name}</span>
                    </button>
                    <span className="hidden w-20 shrink-0 text-right font-mono text-xs text-muted-foreground sm:block">
                      {isDir ? "" : formatBytes(entry.size)}
                    </span>
                    <span className="hidden w-24 shrink-0 text-right text-xs text-muted-foreground md:block">
                      {formatMtime(entry.mtimeMs)}
                    </span>
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
                  </li>
                );
              })}
            </ul>
            {truncated ? (
              <p className="mt-2 text-center text-xs text-muted-foreground">
                List truncated (2000 entries shown)
              </p>
            ) : null}
          </>
        )}
      </div>

      {/* Dialogs */}
      <NameDialog
        open={dialog !== null && dialog.kind === "file"}
        title="New file"
        description={`In ${cwd === "" ? "/" : cwd}`}
        initial=""
        placeholder="file.txt"
        confirmLabel="Create"
        busy={dialogBusy}
        error={dialogError}
        onSubmit={(value) => void createEntry(value, "file")}
        onClose={() => setDialog(null)}
      />
      <NameDialog
        open={dialog !== null && dialog.kind === "folder"}
        title="New folder"
        description={`In ${cwd === "" ? "/" : cwd}`}
        initial=""
        placeholder="folder"
        confirmLabel="Create"
        busy={dialogBusy}
        error={dialogError}
        onSubmit={(value) => void createEntry(value, "folder")}
        onClose={() => setDialog(null)}
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