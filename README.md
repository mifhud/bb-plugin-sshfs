# SSH FS for BB

Mount remote directories over SSH and browse, open, edit, and save files on a
remote server over SFTP — the vscode-sshfs workflow, inside BB. One
connection per mount is reused across the UI and the `bb sshfs` CLI, and idle
connections close themselves.

## Quick start

```sh
npm ci
npm run build
bb plugin install .
```

## 1. Add a config

```sh
bb plugin config sshfs set configs '[{"name":"prod","host":"10.0.0.5","user":"deploy","root":"/srv/app"}]'
```

`host` is the host only — the SSH username lives in its own `user` field.
Optional fields: `port`, `root` (default `/`; `~/path` expands to the remote
home), and `keyPath`. Names are free-form labels (spaces and uppercase are
fine). Manage configs from the **SSH FS** page (add/edit/delete + connect) or
edit the `configs` setting directly in the plugin settings UI.

## 2. Authenticate

Auth order: `keyPath` (with optional `passphrase`) → `password` → `ssh-agent`
(`$SSH_AUTH_SOCK`, the vscode-sshfs default). Secrets live server-side in a
secret setting, never on the wire to the UI — the config dialog saves a
password (or clears one) through a dedicated RPC, and the CLI does the same:

```sh
bb plugin config sshfs set secrets '{"prod":{"password":"…","passphrase":"…"}}'
```

## 3. Browse and edit

- Open **SSH FS** in the sidebar, click **Connect** on a mount, and browse the
  remote tree with breadcrumbs: dirs navigate, files open in an editor tab.
- The editor loads the file over SFTP, tracks unsaved changes, and saves back
  with **Save** or Ctrl/Cmd+S. Binary files and files over 4 MiB are refused
  with a clear message.
- New file / new folder / rename / delete (recursive, confirmed) work from the
  row actions.
- The CLI covers the same surface headlessly:

```sh
bb sshfs list                 # configs + connection state
bb sshfs connect prod         # open the SSH connection
bb sshfs ls prod src          # list (root-relative)
bb sshfs cat prod src/app.ts  # print a text file
bb sshfs write prod src/app.ts --content "…"   # overwrite a file
bb sshfs mkdir prod src/new
bb sshfs mv prod a.txt b.txt
bb sshfs rm prod old-dir      # recursive
bb sshfs disconnect prod
```

## Constraints

- All paths are relative to the mount root; traversal outside it is refused
  before any connection is attempted.
- Reads are capped at 4 MiB and text-only (binary detection via NUL bytes /
  invalid UTF-8); writes at 2 MiB of text.
- Connections idle-close after `idleTimeoutSeconds` (default 60 s; 0 keeps
  them open) and reconnect on the next operation.
- `~` roots need a POSIX remote shell (`$HOME` via `exec`); plain absolute
  roots never do.
- vscode-sshfs extras (PuTTY sessions, hop/proxy, SFTP-sudo, remote terminals,
  shell tasks) are not implemented; keep the SFTP root and auth simple.

## Development

```sh
npm test                      # unit + harness + in-process SSH smoke tests
npm run build                 # bb plugin build
```

The smoke tests run a real ssh2 `Server` over loopback (no sshd needed) and
exercise the full client stack: connection, browse, open, edit/save, rename,
delete, `~` expansion, and the size cap.