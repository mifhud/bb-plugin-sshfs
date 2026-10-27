# Changelog

## 0.1.0 — 2026-10-27

Initial release: mount remote directories over SSH (SFTP) and browse, open,
edit, and save files, mirroring vscode-sshfs.

- Configs (`name`, `host`, `user`, `port`, `root`, `keyPath`) stored in the
  `configs` setting; passwords/passphrases in a server-only `secrets` setting.
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