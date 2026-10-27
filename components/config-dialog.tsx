// Add/edit SSH FS config form. Secrets (password/passphrase) are never
// handled here — they are set server-side with `bb plugin config sshfs
// set secrets '<json>'` and stay off the wire.
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
import type { SshFsConfig } from "../contract";
import { errorMessage } from "./utils";

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function ConfigDialog({
  open,
  initial,
  onClose,
  onSave,
}: {
  open: boolean;
  /** Null = adding a new config; a config = editing it. */
  initial: SshFsConfig | null;
  onClose: () => void;
  onSave: (config: SshFsConfig) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [user, setUser] = useState("");
  const [port, setPort] = useState("22");
  const [root, setRoot] = useState("/");
  const [keyPath, setKeyPath] = useState("");
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
    setError(null);
    setSaving(false);
  }, [open, initial]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving) return;
    if (!NAME_PATTERN.test(name)) {
      setError("Name must be lowercase letters, digits, or dashes");
      return;
    }
    if (host.trim() === "") {
      setError("Host is required (host or user@host)");
      return;
    }
    const parsedPort = Number.parseInt(port, 10);
    if (port.trim() !== "" && !(Number.isInteger(parsedPort) && parsedPort >= 1 && parsedPort <= 65535)) {
      setError("Port must be a number between 1 and 65535");
      return;
    }
    setError(null);
    setSaving(true);
    try {
      await onSave({
        name,
        host: host.trim(),
        ...(user.trim() === "" ? {} : { user: user.trim() }),
        ...(port.trim() === "" ? {} : { port: parsedPort }),
        root: root.trim() === "" ? "/" : root.trim(),
        ...(keyPath.trim() === "" ? {} : { keyPath: keyPath.trim() }),
      });
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
            <div className="space-y-1.5">
              <Label htmlFor="cfg-name">Name</Label>
              <Input
                id="cfg-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="prod"
                autoComplete="off"
              />
            </div>
            <div className="space-y-1.5">
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
            <Label htmlFor="cfg-host">Host (host or user@host)</Label>
            <Input
              id="cfg-host"
              value={host}
              onChange={(event) => setHost(event.target.value)}
              placeholder="deploy@192.168.1.10"
              autoComplete="off"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="cfg-user">User (optional)</Label>
              <Input
                id="cfg-user"
                value={user}
                onChange={(event) => setUser(event.target.value)}
                placeholder="deploy"
                autoComplete="off"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cfg-key">Key path (optional)</Label>
              <Input
                id="cfg-key"
                value={keyPath}
                onChange={(event) => setKeyPath(event.target.value)}
                placeholder="~/.ssh/id_ed25519"
                autoComplete="off"
              />
            </div>
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