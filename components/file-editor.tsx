// Remote file editor tab: load a mounted file over RPC, edit in a plain text
// area, save back over SFTP. Ctrl/Cmd+S saves; unsaved changes are tracked
// and never discarded silently.
import { useCallback, useEffect, useState } from "react";
import type { KeyboardEvent } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../server";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { ConfirmDialog } from "./confirm-dialog";
import { errorMessage, formatBytes, parseMountPath } from "./utils";

export function RemoteFileEditor({
  subPath,
  params,
}: {
  subPath: string;
  params: unknown;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const target = parseMountPath(params);

  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [file, setFile] = useState<{
    content: string;
    size: number;
    mtimeMs: number | null;
    isBinary: boolean;
  } | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [mtime, setMtime] = useState<number | null>(null);

  const load = useCallback(async () => {
    if (target === null) return;
    setState("loading");
    setError(null);
    try {
      const result = await rpc.call("fs_read", { mount: target.mount, path: target.path });
      setFile(result);
      setDraft(result.content);
      setMtime(result.mtimeMs);
      setState("ready");
    } catch (cause) {
      setError(errorMessage(cause));
      setState("error");
    }
  }, [rpc, target?.mount, target?.path]);

  useEffect(() => {
    void load();
  }, [load]);

  if (target === null) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="w-full max-w-sm space-y-2 rounded-lg border border-dashed border-border p-6 text-center">
          <Icon name="EditFile" className="mx-auto size-6 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            Open a remote file from the SSH FS browser (or from{" "}
            <code>/plugins/sshfs/mounts</code>) to edit it here.
          </p>
          {subPath === "" ? null : (
            <p className="font-mono text-xs text-muted-foreground">{subPath}</p>
          )}
        </div>
      </div>
    );
  }

  const dirty = file !== null && draft !== file.content;

  const save = async () => {
    if (!dirty || saving || file === null) return;
    setSaving(true);
    try {
      const result = await rpc.call("fs_write", {
        mount: target.mount,
        path: target.path,
        content: draft,
      });
      setFile({ ...file, content: draft, size: new TextEncoder().encode(draft).byteLength });
      setMtime(result.mtimeMs);
      toast.success("Saved");
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "s") {
      event.preventDefault();
      void save();
    }
  };

  const reload = () => {
    if (dirty) {
      setConfirmDiscard(true);
      return;
    }
    void load();
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Toolbar */}
      <div className="flex items-center gap-2 border-b border-border bg-card px-3 py-2">
        <Icon name="EditFile" className="size-4 shrink-0 text-muted-foreground" />
        <span className="truncate font-mono text-xs" title={`${target.mount}:${target.path}`}>
          {target.mount}:{target.path}
        </span>
        {mtime === null ? null : (
          <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
            {new Date(mtime).toLocaleString()}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-2 text-xs">
          {file !== null && file.isBinary ? (
            <span className="text-muted-foreground">binary · {formatBytes(file.size)}</span>
          ) : (
            <>
              <span
                className={cn(
                  "shrink-0",
                  dirty ? "text-amber-600" : "text-muted-foreground",
                )}
              >
                {dirty ? "● unsaved" : "saved"}
              </span>
              <span className="hidden shrink-0 text-muted-foreground md:inline">
                {formatBytes(file?.size ?? 0)}
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                aria-label="Reload"
                onClick={reload}
                disabled={saving}
              >
                <Icon name="ArrowReloadHorizontal" className="size-3.5" />
              </Button>
              <Button
                size="icon"
                className="size-7"
                aria-label="Save"
                onClick={() => void save()}
                disabled={!dirty || saving}
              >
                <Icon name="Save" className="size-3.5" />
              </Button>
            </>
          )}
        </span>
      </div>

      {/* Body */}
      {state === "loading" ? (
        <p className="p-6 text-center text-sm text-muted-foreground">Loading {target.path}…</p>
      ) : state === "error" ? (
        <div className="flex h-full flex-col items-center justify-center gap-3 p-6">
          <p className="max-w-md text-center text-sm text-destructive">{error}</p>
          <Button variant="outline" size="sm" onClick={() => void load()}>
            Retry
          </Button>
        </div>
      ) : file === null ? null : file.isBinary ? (
        <div className="flex h-full items-center justify-center p-6">
          <div className="w-full max-w-sm space-y-2 rounded-lg border border-dashed border-border p-6 text-center">
            <Icon name="FileAttachment" className="mx-auto size-6 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              {target.path} is a binary file ({formatBytes(file.size)}) and cannot
              be edited here. Use the SSH FS CLI or a remote shell instead.
            </p>
          </div>
        </div>
      ) : (
        <textarea
          className="min-h-0 flex-1 resize-none bg-background p-3 font-mono text-sm leading-relaxed text-foreground outline-none"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          aria-label={`Edit ${target.path}`}
        />
      )}

      <ConfirmDialog
        open={confirmDiscard}
        title="Discard unsaved changes?"
        description={`Your edits to ${target.path} have not been saved. Reloading will discard them.`}
        confirmLabel="Discard"
        onConfirm={() => void load()}
        onClose={() => setConfirmDiscard(false)}
      />
    </div>
  );
}