# Changelog

## Unreleased
- **Editor find & replace bar layout**: the show-replace toggle stays on the left
  before the find field whether or not replace is shown; the replace row uses a
  28px leading spacer so both fields share the same 28px start offset. The bar is a
  CSS grid with a shared capped input track (`minmax(80px, 280px)`), so the Find and
  Replace inputs are always the same width and the find field stretches to the end
  of the replace field (edges aligned). Inline icons (match-case, whole-word, regex,
  count, prev/next, close / preserve-case, replace, replace-all) hug right after
  the field instead of spreading to the far edge, so the bar no longer sprawls wider
  on the replace side.

 - **Find & replace in the editor**: a Monaco-style widget — **Ctrl/Cmd+F**
   opens find, **Ctrl/Cmd+H** adds the replace row. Monaco-like layout with
   icon buttons (prev/next chevrons, replace toggle, close) and glyph toggles
   **Aa** (match case), **ab** (whole word), **.*** (regex) inline to the
   right of the find field, and **aA** (preserve case) in the replace row
   (Alt+C/W/R/P). Live highlights over the text (current match emphasized),
   match count with next/prev (Enter / Shift+Enter), circular-arrow **↻**
   (replace) / same with a center dot **⊙** (replace all) icon buttons, red
   input border on no-results or an invalid expression; `$&`, `$$` (and `$1`-`$99` in
   regex mode) expand in replacements. Escape closes the widget and removes the
   highlights.
- **Editor toolbar**: simplified to show only the file path (truncated from
  the front so the filename stays visible), save, and reload icon buttons
  (removed the mtime, file-size, and dirty-status text). The find/replace bar
  has tighter spacing, tooltips on every icon button, and collapses non-essential
  toggles (match case, whole word, regex, preserve-case, count, replace actions) on
  narrow panels so only the find/replace fields, prev/next, close, and replace-toggle
  remain.
  - **Right-click create menu**: **New file / New folder** moved out of the
   browser toolbar into a text-only context menu — right-click a row or empty
   space in the listing to create in the current directory. Right-clicking a
   folder entry creates inside that folder (and right-clicking a file entry
   creates in that file's parent directory), so the create target always
   matches the entry you right-clicked instead of the breadcrumb path.
  Expanded folders no longer get stuck on "Loading" after a create/rename/delete/
   refresh: `invalidate()` now clears the children cache alongside the listing
   cache, so `loadChildren` actually re-fetches instead of bailing out on stale cache.
- **Name filter**: the browser toolbar now has a filter box that hides files
  and folders whose name doesn't contain the typed text (case-insensitive,
  applies to expanded children too), with a clear button and a "No matches"
  state.
- **Unsaved edits survive tab switches**: the editor keeps a draft of every
  keystroke (frontend-only, per `mount:path`) and restores it when you come
  back, so switching editor tabs or leaving the panel never discards work
  silently. Reopening a file that still has an unsaved draft asks **Keep
  draft / Discard / Cancel** instead of restoring it silently.
- **Sortable listing**: click the **Name** / **Size** / **Last modified**
  column headers to sort the browser (asc/desc, mtime defaults to
  newest-first); the choice persists across mounts and reloads. Expanded
  folders sort with the same rule.
- **Expandable folders**: the **>** chevron on a dir row expands/collapses
  its contents in place (nested, cached per mount), while clicking the
  folder row still navigates into it — peek without leaving the path.
- **Browser toolbar layout**: the path breadcrumb is its own full-width row
  with the tools (new file / new folder / refresh) in a separate row below,
  left-aligned, using the plain header styling.
- **Icon consistency**: the browser's mount-root button and empty state now
  use the built-in `Terminal` icon like the nav panel and settings branding.

## 0.2.0 — 2026-10-27

- **Fix remote writes**: the file mode was passed where ssh2 expects the open
  flags, so real servers rejected saves of 0644 files ("write …: not found")
  or truncated them empty. Writes now open with proper `w` flags and keep the
  original permissions.
- **Test connection**: plug button per mount row (and `bb sshfs test <name>`)
  verifies SSH auth + SFTP channel + root resolution and reports latency; an
  already-open connection is reused, not closed.
- **Multiple servers as tabs**: every connected mount shows as a tab above the
  browser, so switching between servers is one click (the first connected
  mount is auto-selected on load).
- **Collapsible + resizable mounts panel**: hide the list with the panel
  button (reopened from a `Mounts` button in the browser area) and drag its
  edge to resize; panel size/visibility persist across reloads.
- **Icon fixes**: SSH FS uses the built-in `Terminal` icon everywhere (nav
  panel, plugin settings/branding, the browser's mount-root breadcrumb
  button, and the empty state); the mounts show/hide button uses
  `PanelLeft`, the connection-test button uses `Plug02`, and the editor saves
  with a real floppy-disk **Save** icon (registered by the plugin) with
  Reload as an icon button — all names now resolve in the BB host icon set
  instead of falling back to the default `Zap`.
- **Mount session memory**: the page remembers each mount's last directory
  and restores it when you return or switch tabs; mounts that were connected
  recently are auto-reconnected silently on return (no forced manual
  connect) as long as the session hasn't ended. Once a disconnected mount's
  window has elapsed, its remembered directory is forgotten so the next
  connect lands on the mount root again. Window configurable via the
  `sessionRememberSeconds` setting (default 600 s, 0 = off); manual
  disconnects always end the session but keep the directory, and after
  disconnecting everything the page returns to the neutral hint — it never
  parks the browser on a disconnected mount with a connect prompt.

## 0.1.0 — 2026-10-27

Initial release: mount remote directories over SSH (SFTP) and browse, open,
edit, and save files, mirroring vscode-sshfs.

- Configs (free-form `name`, `host` only + `user`, `port`, `root`,
  `keyPath`) stored in the `configs` setting; passwords/passphrases in a
  server-only `secrets` setting — saveable and clearable from the config
  dialog via the `secrets_set` RPC.
- One reused connection per mount with configurable idle close
  (`idleTimeoutSeconds`).
- SSH FS sidebar page: mount list with connection state, breadcrumb file
  browser (navigate, open, new file/folder, rename, delete, refresh).
- Remote file editor tab with dirty tracking, Ctrl/Cmd+S save, and binary /
  size-cap refusal (4 MiB read, 2 MiB write).
- `bb sshfs` CLI: `list`, `connect`, `disconnect`, `ls`, `cat`, `write`,
  `mkdir`, `rm`, `mv`.
- Root confinement (traversal refused before connecting), recursive delete,
  `~` root expansion via remote `$HOME`.
- Tests: path/config units, SftpManager lifecycle, realSession against an
  in-memory SFTP, fake-plugin-host RPC/CLI harness, frontend slot tests, and
  end-to-end smoke over a real in-process ssh2 server.