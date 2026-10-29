// Remote file editor tab: load a mounted file over RPC, edit in a plain text
// area, save back over SFTP. Ctrl/Cmd+S saves; unsaved changes are tracked
// and never discarded silently. Ctrl/Cmd+F and Ctrl/Cmd+H open a Monaco-like
// find/replace widget: live highlights over the text, match count, next/prev,
// match case, whole word, regex, preserve case, and replace/replace-all.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../server";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { ConfirmDialog } from "./confirm-dialog";
import {
  findMatches,
  replaceAllInText,
  replaceRangeInText,
  type FindOptions,
} from "./find-replace";
import { clearDirtyDraft, getDirtyDraft, setDirtyDraft } from "./draft-store";
import { errorMessage, formatBytes, parseMountPath } from "./utils";
import { frontTruncate } from "./path-truncate";

/** Colored match layer: normal text is transparent so the textarea's own
 * glyphs show through; only the highlight rectangles are visible. */
function HighlightLayer({
  text,
  matches,
  activeIndex,
}: {
  text: string;
  matches: readonly (readonly [number, number])[];
  activeIndex: number;
}) {
  const nodes: ReactNode[] = [];
  let pos = 0;
  matches.forEach(([start, end], index) => {
    if (start > pos) nodes.push(<span key={`t-${pos}`}>{text.slice(pos, start)}</span>);
    const active = index === activeIndex;
    nodes.push(
      <mark
        key={`m-${index}`}
        data-active-match={active ? "" : undefined}
        className={cn("rounded-sm", active ? "bg-primary/40" : "bg-primary/20")}
      >
        {text.slice(start, end)}
      </mark>,
    );
    pos = end;
  });
  if (pos < text.length) nodes.push(<span key={`t-${pos}`}>{text.slice(pos)}</span>);
  return <>{nodes}</>;
}

/** Monaco find-widget toggle: a small square button carrying a glyph,
 * e.g. `Aa` (match case), `ab` (whole word), `.*` (regex). */
function FindToggle({
  glyph,
  label,
  active,
  onClick,
  title,
  className,
}: {
  glyph: string;
  label: string;
  active: boolean;
  onClick: () => void;
  title?: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      aria-label={label}
      title={title}
      onClick={onClick}
      className={cn(
        "flex h-6 min-w-6 items-center justify-center rounded-sm px-1 font-mono text-[11px] font-medium transition-colors",
        active
          ? "bg-state-active text-foreground"
          : "text-muted-foreground hover:bg-state-hover hover:text-foreground",
        className,
      )}
    >
      {glyph}
    </button>
  );
}

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

  // Find/replace widget state (Monaco find widget semantics).
  const [findOpen, setFindOpen] = useState(false);
  const [showReplace, setShowReplace] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [replaceQuery, setReplaceQuery] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [preserveCase, setPreserveCase] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const backdropRef = useRef<HTMLDivElement | null>(null);
  const findInputRef = useRef<HTMLInputElement | null>(null);
  const pathRef = useRef<HTMLSpanElement | null>(null);
  const measureRef = useRef<HTMLSpanElement | null>(null);
  const [displayPath, setDisplayPath] = useState("");
  const findBarRef = useRef<HTMLDivElement | null>(null);
  const [isCompact, setIsCompact] = useState(false);
  const load = useCallback(async () => {
    if (target === null) return;
    setState("loading");
    setError(null);
    try {
      const result = await rpc.call("fs_read", { mount: target.mount, path: target.path });
      setFile(result);
      const stored = getDirtyDraft(target.mount, target.path);
      if (stored !== undefined && stored.content !== result.content) {
        // A remounted tab keeps its unsaved edit; the fetched copy is the
        // saved baseline it diffs against.
        setDraft(stored.content);
      } else {
        setDraft(result.content);
        if (stored !== undefined) clearDirtyDraft(target.mount, target.path);
      }
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

  const applyDraft = (value: string) => {
    setDraft(value);
    if (file !== null && value !== file.content) {
      setDirtyDraft({ mount: target.mount, path: target.path, content: value });
    } else if (file !== null) {
      clearDirtyDraft(target.mount, target.path);
    }
  };

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
      clearDirtyDraft(target.mount, target.path);
      toast.success("Saved");
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  // ---- Find & replace logic -------------------------------------------------

  const findOptions: FindOptions = { matchCase, wholeWord, regex: useRegex };
  const { matches, valid } = useMemo(
    () => findMatches(draft, findQuery, findOptions),
    [draft, findQuery, matchCase, wholeWord, useRegex],
  );
  const safeActive = matches.length === 0 ? 0 : Math.min(activeIndex, matches.length - 1);

  const openFind = (withReplace: boolean) => {
    const textarea = textareaRef.current;
    if (textarea !== null && textarea.selectionEnd > textarea.selectionStart) {
      setFindQuery(textarea.value.slice(textarea.selectionStart, textarea.selectionEnd));
      setActiveIndex(0);
    }
    setShowReplace(withReplace);
    setFindOpen(true);
    queueMicrotask(() => findInputRef.current?.focus());
  };

  const stepMatch = (delta: number) => {
    if (matches.length === 0) return;
    setActiveIndex((safeActive + delta + matches.length) % matches.length);
  };

  const replaceOne = () => {
    if (!valid || matches.length === 0) return;
    const [start, end] = matches[safeActive];
    const result = replaceRangeInText(
      draft,
      findQuery,
      findOptions,
      replaceQuery,
      preserveCase,
      start,
      end,
    );
    if (!result.valid) return;
    applyDraft(result.text);
    // Jump to the next match after the replaced span (the replacement itself
    // is never re-searched, matching Monaco).
    const next = findMatches(result.text, findQuery, findOptions).matches;
    const after = next.findIndex(([matchStart]) => matchStart >= start + result.next.length);
    setActiveIndex(
      after === -1 ? Math.min(safeActive, Math.max(0, next.length - 1)) : after,
    );
  };

  const replaceAll = () => {
    if (!valid) return;
    const result = replaceAllInText(
      draft,
      findQuery,
      findOptions,
      replaceQuery,
      preserveCase,
    );
    if (!result.valid || result.count === 0) return;
    applyDraft(result.text);
    setActiveIndex(0);
    toast.success(`Replaced ${result.count} occurrence${result.count === 1 ? "" : "s"}`);
  };

  const toggleFindOption = (option: "matchCase" | "wholeWord" | "regex" | "preserveCase") => {
    setActiveIndex(0);
    if (option === "matchCase") setMatchCase((value) => !value);
    else if (option === "wholeWord") setWholeWord((value) => !value);
    else if (option === "regex") setUseRegex((value) => !value);
    else setPreserveCase((value) => !value);
  };

  const onFindInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      if (event.shiftKey) stepMatch(-1);
      else stepMatch(1);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setFindOpen(false);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      stepMatch(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      stepMatch(-1);
    } else if (event.altKey) {
      const key = event.key.toLowerCase();
      if (key === "c" || key === "w" || key === "r" || key === "p") {
        event.preventDefault();
        toggleFindOption(key === "c" ? "matchCase" : key === "w" ? "wholeWord" : key === "r" ? "regex" : "preserveCase");
      }
    }
  };

  const onReplaceInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      replaceOne();
    } else if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      replaceAll();
    } else if (event.altKey && event.key === "Enter") {
      event.preventDefault();
      replaceAll();
    } else if (event.key === "Escape") {
      event.preventDefault();
      setFindOpen(false);
    } else if (event.altKey) {
      const key = event.key.toLowerCase();
      if (key === "c" || key === "w" || key === "r" || key === "p") {
        event.preventDefault();
        toggleFindOption(key === "c" ? "matchCase" : key === "w" ? "wholeWord" : key === "r" ? "regex" : "preserveCase");
      }
    }
  };

  // Keep the highlight layer scrolled with the textarea.
  const onTextareaScroll = () => {
    const textarea = textareaRef.current;
    if (backdropRef.current !== null && textarea !== null) {
      backdropRef.current.scrollTop = textarea.scrollTop;
    }
  };

  // Bring the active match into view when it changes (the textarea own
  // scrollbar is the scroll container; the backdrop mirrors its offset).
  useLayoutEffect(() => {
    if (!findOpen) return;
    const backdrop = backdropRef.current;
    const textarea = textareaRef.current;
    if (backdrop === null || textarea === null) return;
    const mark = backdrop.querySelector<HTMLElement>("[data-active-match]");
    if (mark === null) return;
    const backdropRect = backdrop.getBoundingClientRect();
    const markRect = mark.getBoundingClientRect();
    const target =
      textarea.scrollTop + (markRect.top - backdropRect.top) - textarea.clientHeight / 2 + markRect.height / 2;
    const max = Math.max(0, textarea.scrollHeight - textarea.clientHeight);
    textarea.scrollTop = Math.min(Math.max(0, target), max);
  }, [findOpen, safeActive]);

  const fullPath = `${target.mount}:${target.path}`;

  // Front-truncate the toolbar path: keep the filename end visible
  // (`…/path/to/test1.txt`) when the path overflows its container.
  // CSS `direction: rtl` + `text-overflow: ellipsis` is unreliable across
  // browsers, so we measure precisely with a hidden span + ResizeObserver.
  useLayoutEffect(() => {
    const span = pathRef.current;
    const measure = measureRef.current;
    if (!span || !measure) {
      setDisplayPath(fullPath);
      return;
    }

    const truncate = () => {
      try {
        setDisplayPath(
          frontTruncate(fullPath, span.clientWidth, (candidate) => {
            measure.textContent = candidate;
            return measure.scrollWidth;
          }),
        );
      } finally {
        measure.textContent = "";
      }
    };

    truncate();

    const ro = new ResizeObserver(truncate);
    ro.observe(span);
    return () => ro.disconnect();
  }, [fullPath]);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const modifier = event.metaKey || event.ctrlKey;
    if (modifier && event.key.toLowerCase() === "f") {
      event.preventDefault();
      openFind(false);
      return;
    }
    if (modifier && event.key.toLowerCase() === "h") {
      event.preventDefault();
      openFind(true);
      return;
    }
    if (event.key === "Escape" && findOpen) {
      event.preventDefault();
      setFindOpen(false);
      return;
    }
    if (modifier && event.key === "s") {
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

  const editable = state === "ready" && file !== null && !file.isBinary;
  const showFindBar = findOpen && editable;

  // Find/replace bar: hide non-essential toggles when the container is too
  // narrow for everything to fit. Only the find/replace fields, prev/next,
  // close, and show-replace toggle stay visible.
  useLayoutEffect(() => {
    const bar = findBarRef.current;
    if (!bar) return;

    const check = () => {
      const width = bar.clientWidth;
      if (width === 0) return; // not laid out (e.g. jsdom) — keep default state
      setIsCompact(width < 320);
    };

    check();

    const ro = new ResizeObserver(check);
    ro.observe(bar);
    return () => ro.disconnect();
  }, [showFindBar]);

  const countText =
    findQuery === ""
      ? ""
      : !valid
        ? "Invalid expr."
        : matches.length === 0
          ? "No results"
          : `${safeActive + 1}/${matches.length}`;

      const toggleButton = (
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          aria-label={showReplace ? "Hide replace" : "Show replace"}
          title={showReplace ? "Hide replace (Ctrl+H)" : "Show replace (Ctrl+H)"}
          aria-expanded={showReplace}
          onClick={() => setShowReplace((value) => !value)}
        >
          <Icon
            name="ChevronDown"
            className={cn("size-3.5 transition-transform", showReplace && "rotate-180")}
          />
        </Button>
      );

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Toolbar */}
      <div className="flex items-center gap-2 border-b border-border bg-card px-3 py-2">
        <Icon name="EditFile" className="size-4 shrink-0 text-muted-foreground" />
        <span
          ref={pathRef}
          className="flex-1 min-w-0 truncate font-mono text-xs"
          title={fullPath}
        >
          {displayPath || fullPath}
        </span>
        {/* Hidden measurement span for front-truncation (mirrors path span font); */}
        {/* content is set programmatically in the useLayoutEffect below. */}
        <span
          ref={measureRef}
          className="absolute left-[-9999px] top-[-9999px] font-mono text-xs whitespace-nowrap"
          aria-hidden="true"
          style={{ visibility: "hidden" }}
        />
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {file !== null && file.isBinary ? null : (
            <>
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

      {/* Find / replace bar */}
      {showFindBar ? (
        <div ref={findBarRef} className="grid grid-cols-[28px_minmax(80px,280px)_auto] gap-0.5 border-b border-border bg-card px-3 py-2 text-xs">
          <div className="contents">
            {toggleButton}
            <div className="min-w-0 w-full">
              <Input
                ref={findInputRef}
                value={findQuery}
                onChange={(event) => {
                  setFindQuery(event.target.value);
                  setActiveIndex(0);
                }}
                onKeyDown={onFindInputKeyDown}
                placeholder="Find"
                aria-label="Find"
                className={cn(
                  "h-7 min-w-[80px] text-xs",
                  findQuery !== "" &&
                    (!valid || matches.length === 0) &&
                    "border-destructive focus-visible:ring-destructive",
                )}
              />
            </div>
            <div className="flex items-center gap-0.5">
              <FindToggle
                glyph="Aa"
                label="Match case"
                active={matchCase}
                onClick={() => toggleFindOption("matchCase")}
                title="Match case (Alt+C)"
                className={isCompact ? "hidden" : "hidden sm:inline-flex"}
              />
              <FindToggle
                glyph="ab"
                label="Match whole word"
                active={wholeWord}
                onClick={() => toggleFindOption("wholeWord")}
                title="Match whole word (Alt+W)"
                className={isCompact ? "hidden" : "hidden sm:inline-flex"}
              />
              <FindToggle
                glyph=".*"
                label="Use regular expression"
                active={useRegex}
                onClick={() => toggleFindOption("regex")}
                title="Use regular expression (Alt+R)"
                className={isCompact ? "hidden" : "hidden sm:inline-flex"}
              />
              {findQuery !== "" ? (
                <span
                  className={cn(
                    "hidden shrink-0 text-right tabular-nums text-muted-foreground",
                    valid && matches.length === 0 && "text-destructive",
                    !isCompact && "sm:inline-flex",
                  )}
                >
                  {countText}
                </span>
              ) : null}
              <Button
                variant="ghost"
                size="icon"
                className="size-7 shrink-0"
                aria-label="Previous match"
                title="Previous match (Enter)"
                onClick={() => stepMatch(-1)}
                disabled={!valid || matches.length === 0}
              >
                <Icon name="ChevronUp" className="size-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 shrink-0"
                aria-label="Next match"
                title="Next match (Enter)"
                onClick={() => stepMatch(1)}
                disabled={!valid || matches.length === 0}
              >
                <Icon name="ChevronDown" className="size-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 shrink-0"
                aria-label="Close find"
                title="Close (Escape)"
                onClick={() => setFindOpen(false)}
              >
                <Icon name="X" className="size-3.5" />
              </Button>
            </div>
          </div>
          {showReplace ? (
            <div className="contents">
              {/* 28px spacer mirrors the toggle column on row 1, so the replace */}
              {/* field starts at the same x as the find field and shares its cap. */}
              <div className="w-7" aria-hidden="true" />
              <div className="min-w-0 w-full">
                <Input
                  value={replaceQuery}
                  onChange={(event) => setReplaceQuery(event.target.value)}
                  onKeyDown={onReplaceInputKeyDown}
                  placeholder="Replace"
                  aria-label="Replace"
                  className="h-7 min-w-[80px] text-xs"
                />
              </div>
              <div className="flex items-center gap-0.5">
                <FindToggle
                  glyph="aA"
                  label="Preserve case"
                  active={preserveCase}
                  onClick={() => toggleFindOption("preserveCase")}
                  title="Preserve case (Alt+P)"
                  className={isCompact ? "hidden" : "hidden sm:inline-flex"}
                />
                <Button
                  variant="ghost"
                  size="icon"
                  className={isCompact ? "size-7 shrink-0 hidden" : "size-7 shrink-0 hidden sm:inline-flex"}
                  aria-label="Replace"
                  title="Replace"
                  onClick={replaceOne}
                  disabled={!valid || matches.length === 0}
                >
                  <Icon name="Replace" className="size-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className={isCompact ? "size-7 shrink-0 hidden" : "size-7 shrink-0 hidden sm:inline-flex"}
                  aria-label="Replace all"
                  title="Replace all"
                  onClick={replaceAll}
                  disabled={!valid || matches.length === 0}
                >
                  <Icon name="ReplaceAll" className="size-3.5" />
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

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
        <div className="relative min-h-0 flex-1 bg-background">
          {showFindBar && matches.length > 0 ? (
            <div
              ref={backdropRef}
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 overflow-hidden"
            >
              <pre className="whitespace-pre-wrap break-words p-3 font-mono text-sm leading-relaxed text-transparent">
                <HighlightLayer text={draft} matches={matches} activeIndex={safeActive} />
              </pre>
            </div>
          ) : null}
          <textarea
            ref={textareaRef}
            className={cn(
              "relative h-full w-full resize-none p-3 font-mono text-sm leading-relaxed text-foreground outline-none",
              // With matches, the textarea turns transparent so the highlight
              // layer rendered behind it stays visible.
              showFindBar && matches.length > 0 ? "bg-transparent" : "bg-background",
            )}
            value={draft}
            onChange={(event) => applyDraft(event.target.value)}
            onKeyDown={onKeyDown}
            onScroll={onTextareaScroll}
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            aria-label={`Edit ${target.path}`}
          />
        </div>
      )}

      <ConfirmDialog
        open={confirmDiscard}
        title="Discard unsaved changes?"
        description={`Your edits to ${target.path} have not been saved. Reloading will discard them.`}
        confirmLabel="Discard"
        onConfirm={() => {
          clearDirtyDraft(target.mount, target.path);
          void load();
        }}
        onClose={() => setConfirmDiscard(false)}
      />
    </div>
  );
}