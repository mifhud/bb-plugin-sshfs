# SSH FS

Mount remote directories over SSH (SFTP) in BB — the vscode-sshfs workflow:
browse, open, edit, and save files on a remote server as if they were local.

## What you get

- **Configs** stored in the plugin's `configs` setting (JSON): `name`,
  `host` (`host` or `user@host`), optional `user`, `port`, `root` (the
  mounted directory, `~`-aware), and `keyPath`. Managed from the SSH FS page
  or `bb plugin config sshfs set configs '…'`.
- **Secrets** (passwords/passphrases) in a secret setting, server-only, keyed
  by config name. Auth order: key → password → ssh-agent.
- **SSH FS page** (sidebar → SSH FS): mount list with live connection state,
  and a breadcrumb file browser over SFTP — dirs navigate, files open in an
  editor tab, with new file / new folder / rename / delete and refresh.
- **Remote file editor**: loads over RPC+SFTP, tracks unsaved changes, saves
  back with Save or Ctrl/Cmd+S; binary and oversized (> 4 MiB) files are
  refused with an explanation.
- **`bb sshfs` CLI**: `list`, `connect`, `disconnect`, `ls`, `cat`, `write`,
  `mkdir`, `rm`, `mv` — the same connection pool as the UI.
- **Connection reuse + idle close**: one SSH connection per config shared
  across UI and CLI; idle connections close after `idleTimeoutSeconds`
  (default 60 s) and reconnect on the next operation.

## How it works

The server keeps a per-mount connection pool (`lib/sftp.ts`, `ssh2`). Every
RPC/CLI call resolves the config and secrets, opens or reuses the mount's
connection, runs the SFTP operation root-confined (traversal is refused before
connecting), and releases the lease. Read/write go through a size cap and
binary detection; directory deletes are recursive; `~` roots expand via a
remote `$HOME` over the exec channel. The frontend talks to the server only
through the typed RPC contract (`contract.ts`), refreshing on
`sshfs-changed` realtime signals so CLI actions update open pages.

## Requirements

BB 0.47 or later (SDK 0.6.80), Node 22 (for `Promise.withResolvers`), an SSH
server reachable from the BB server machine, and either an ssh-agent, a
password secret, or a key path. SFTP must be enabled on the remote (the
default OpenSSH setup). No external service or account required.

## Not implemented (vscode-sshfs extras)

PuTTY session configs, hop/proxy chains, SFTP-sudo (root escalation), remote
terminals, and ssh-shell tasks. Keep the SFTP root and auth simple; the four
core behaviors — SSH connection, remote browsing, file open/edit/save over
SFTP — are complete and covered by unit, harness, frontend, and real-transport
smoke tests.