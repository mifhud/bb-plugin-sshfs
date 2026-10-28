# Changelog

## Unreleased

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