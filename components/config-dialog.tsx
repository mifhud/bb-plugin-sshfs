// Add/edit SSH FS config form. `host` is the host only (the SSH username has
// its own field), names are free-form, and a password can be saved right here
// — it goes to the server-only `secrets` setting via RPC, never into the
// config or the frontend store.
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ConfigView, SshFsConfig } from "../contract";
import { errorMessage } from "./utils";

export type PasswordAction = { kind: "set"; value: string } | { kind: "clear" };

export function ConfigDialog({
  open,
  initial,
  onClose,
  onSave,
}: {
  open: boolean;
  /** Null = adding a new config; a saved config = editing it. */
  initial: ConfigView | null;
  onClose: () => void;
  onSave: (config: SshFsConfig, passwordAction?: PasswordAction) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [user, setUser] = useState("");
  const [port, setPort] = useState("22");
  const [root, setRoot] = useState("/");
  const [keyPath, setKeyPath] = useState("");
  const [password, setPassword] = useState("");
  const [clearPassword, setClearPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(initial?.name ?? "");
    setHost(initial?.host ?? "");
    setUser(initial?.user ?? "");
    setPort(initial?.port === undefined ? "22" : String(initial.port));
    setRoot(initial?.root ?? "/");
    setKeyPath(initial?.keyPath ?? "");
    setPassword("");
    setClearPassword(false);
    setError(null);
    setSaving(false);
  }, [open, initial]);

  const hasSavedPassword = initial?.hasPassword === true;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving) return;
    if (name.trim() === "" || name.trim().length > 100) {
      setError("Name is required (max 100 characters)");
      return;
    }
    if (host.trim() === "") {
      setError("Host is required");
      return;
    }
    if (host.includes("@")) {
      setError("Host is the host only — put the username in the User field");
      return;
    }
    const parsedPort = Number.parseInt(port, 10);
    if (port.trim() !== "" && !(Number.isInteger(parsedPort) && parsedPort >= 1 && parsedPort <= 65535)) {
      setError("Port must be a number between 1 and 65535");
      return;
    }
    let passwordAction: PasswordAction | undefined;
    if (clearPassword) passwordAction = { kind: "clear" };
    else if (password !== "") passwordAction = { kind: "set", value: password };
    setError(null);
    setSaving(true);
    try {
      await onSave(
        {
          name: name.trim(),
          host: host.trim(),
          ...(user.trim() === "" ? {} : { user: user.trim() }),
          ...(port.trim() === "" ? {} : { port: parsedPort }),
          root: root.trim() === "" ? "/" : root.trim(),
          ...(keyPath.trim() === "" ? {} : { keyPath: keyPath.trim() }),
        },
        passwordAction,
      );
    } catch (cause) {
      setError(errorMessage(cause));
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="w-full max-w-md">
        <DialogHeader>
          <DialogTitle>{initial === null ? "Add SSH FS config" : `Edit ${initial.name}`}</DialogTitle>
          <DialogDescription>
            Mount a remote directory over SSH. File paths in the browser are
            relative to the root below.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="min-w-0 space-y-1.5">
              <Label htmlFor="cfg-name">Name</Label>
              <Input
                id="cfg-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="prod"
                autoComplete="off"
              />
            </div>
            <div className="min-w-0 space-y-1.5">
              <Label htmlFor="cfg-port">Port</Label>
              <Input
                id="cfg-port"
                type="number"
                min={1}
                max={65535}
                value={port}
                onChange={(event) => setPort(event.target.value)}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cfg-host">Host</Label>
            <Input
              id="cfg-host"
              value={host}
              onChange={(event) => setHost(event.target.value)}
              placeholder="10.0.0.5 or my-server.local"
              autoComplete="off"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cfg-user">User</Label>
            <Input
              id="cfg-user"
              value={user}
              onChange={(event) => setUser(event.target.value)}
              placeholder="deploy"
              autoComplete="off"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cfg-key">Key path</Label>
            <Input
              id="cfg-key"
              value={keyPath}
              onChange={(event) => setKeyPath(event.target.value)}
              placeholder="~/.ssh/id_ed25519 (optional)"
              autoComplete="off"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cfg-root">Root (mounted directory)</Label>
            <Input
              id="cfg-root"
              value={root}
              onChange={(event) => setRoot(event.target.value)}
              placeholder="/srv/app or ~/code"
              autoComplete="off"
            />
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="cfg-password">Password</Label>
              {hasSavedPassword ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 px-1.5 text-xs text-muted-foreground"
                  onClick={() => {
                    setClearPassword(true);
                    setPassword("");
                  }}
                >
                  Clear saved password
                </Button>
              ) : null}
            </div>
            <Input
              id="cfg-password"
              type="password"
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
                setClearPassword(false);
              }}
              placeholder={
                hasSavedPassword
                  ? "Password saved — leave blank to keep it"
                  : "Server password (optional)"
              }
              autoComplete="new-password"
            />
            {hasSavedPassword && clearPassword ? (
              <p className="text-xs text-muted-foreground">
                The saved password will be removed on save.
              </p>
            ) : null}
          </div>
          {error === null ? null : <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {initial === null ? "Add" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}