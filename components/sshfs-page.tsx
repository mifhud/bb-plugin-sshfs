// SSH FS page: mount list on the left (add/edit/delete/connect), remote file
// browser on the right. Configuration is stored in the plugin's `configs`
// setting (JSON); secrets stay server-side.
import { useCallback, useEffect, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../server";
import type { ConfigView, SshFsConfig } from "../contract";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { RemoteBrowser } from "./remote-browser";
import { ConfigDialog, type PasswordAction } from "./config-dialog";
import { ConfirmDialog } from "./confirm-dialog";
import { errorMessage } from "./utils";

const SSHF_CHANGED = "sshfs-changed";

function useConfigs() {
  const rpc = useRpc<typeof rpcContract>();
  const [configs, setConfigs] = useState<ConfigView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try {
      const result = await rpc.call("configs_list", null);
      setConfigs(result.configs);
      setError(null);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, [rpc]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { configs, error, reload };
}

export function SshFsPage({ subPath }: { subPath: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const { configs, error, reload } = useConfigs();

  const [selected, setSelected] = useState<string | null>(null);
  const [busyName, setBusyName] = useState<string | null>(null);
  const [testingName, setTestingName] = useState<string | null>(null);
  const [configDialog, setConfigDialog] = useState<{ mode: "add" } | { mode: "edit"; config: ConfigView } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ConfigView | null>(null);
  const [browserKey, setBrowserKey] = useState(0);
  const [panelOpen, setPanelOpen] = useState(() => loadBoolean("panelOpen", true));
  const [panelWidth, setPanelWidth] = useState(() => loadNumber("panelWidth", 288));

  // Remember panel size/visibility across reloads (best-effort).
  useEffect(() => {
    try {
      window.localStorage.setItem("sshfs:panelWidth", String(panelWidth));
      window.localStorage.setItem("sshfs:panelOpen", panelOpen ? "1" : "0");
    } catch {
      // storage unavailable: panel state is session-only
    }
  }, [panelWidth, panelOpen]);

  // Any change (this page, the CLI, another window) refreshes the list.
  useRealtime(SSHF_CHANGED, () => {
    void reload();
  });

  // Drop a stale selection (config removed/renamed).
  useEffect(() => {
    if (configs === null) return;
    if (selected !== null && !configs.some((config) => config.name === selected)) {
      setSelected(null);
    }
  }, [configs, selected]);

  // Auto-select the first connected mount so an open tab is always useful.
  useEffect(() => {
    if (selected === null && configs !== null) {
      const firstConnected = configs.find((config) => config.connected);
      if (firstConnected !== undefined) setSelected(firstConnected.name);
    }
  }, [selected, configs]);

  const selectedConfig = configs?.find((config) => config.name === selected) ?? null;
  const connectedTabs = configs === null ? [] : configs.filter((config) => config.connected);

  // Pointer-driven resize of the mounts panel (clamped, no layout thrash).
  const onResizeStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = panelWidth;
    const onMove = (move: PointerEvent) => {
      setPanelWidth(Math.min(512, Math.max(176, startWidth + move.clientX - startX)));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const testConnection = async (name: string) => {
    setTestingName(name);
    try {
      const result = await rpc.call("mounts_test", { name });
      toast.success(`Connection OK (${result.latencyMs} ms)`);
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setTestingName(null);
    }
  };

  const connect = async (name: string) => {
    setBusyName(name);
    try {
      await rpc.call("mounts_connect", { name });
      toast.success(`Connected ${name}`);
      setSelected(name);
      await reload();
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setBusyName(null);
    }
  };

  const disconnect = async (name: string) => {
    setBusyName(name);
    try {
      await rpc.call("mounts_disconnect", { name });
      await reload();
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setBusyName(null);
    }
  };

  const saveConfig = async (config: SshFsConfig, passwordAction?: PasswordAction) => {
    if (configs === null) throw new Error("Configs not loaded yet");
    const exists = configs.some((candidate) => candidate.name === config.name);
    const next: ConfigView[] = configs.map((candidate) =>
      candidate.name === config.name
        ? { ...config, connected: candidate.connected, hasPassword: candidate.hasPassword }
        : candidate,
    );
    if (!exists) next.push({ ...config, connected: false, hasPassword: false });
    const result = await rpc.call("configs_save", { configs: next.map(stripConnected) });
    if (passwordAction !== undefined) {
      await rpc.call("secrets_set", {
        name: config.name,
        password: passwordAction.kind === "set" ? passwordAction.value : null,
      });
    }
    toast.success(exists ? `Saved ${config.name}` : `Added ${config.name}`);
    setConfigDialog(null);
    setSelected(config.name);
    await reload();
    if (result.configs.some((view) => view.name === config.name)) {
      await connect(config.name);
    }
  };

  const deleteConfig = async () => {
    if (confirmDelete === null || configs === null) return;
    const target = confirmDelete;
    try {
      await rpc.call("configs_save", {
        configs: configs.filter((config) => config.name !== target.name).map(stripConnected),
      });
      toast.success(`Removed ${target.name}`);
      if (selected === target.name) setSelected(null);
      await reload();
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setConfirmDelete(null);
    }
  };

  return (
    <div className="flex h-full min-h-0">
      {/* Mount list (collapsible + resizable) */}
      {panelOpen ? (
        <>
          <aside
            style={{ width: panelWidth }}
            className="flex shrink-0 flex-col border-r border-border bg-card"
          >
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <h2 className="text-sm font-medium">Mounts</h2>
          <span className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 text-xs"
              onClick={() => setConfigDialog({ mode: "add" })}
            >
              <Icon name="Plus" className="size-3.5" />
              Add
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label="Hide mounts panel"
              onClick={() => setPanelOpen(false)}
            >
              <Icon name="PanelLeftClose" className="size-3.5 text-muted-foreground" />
            </Button>
          </span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {error !== null ? (
            <p className="px-2 py-4 text-center text-sm text-destructive">{error}</p>
          ) : configs === null ? (
            <p className="px-2 py-4 text-center text-sm text-muted-foreground">Loading configs…</p>
          ) : configs.length === 0 ? (
            <div className="space-y-3 px-2 py-6 text-center">
              <Icon name="Globe" className="mx-auto size-6 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                No SSH FS configs yet. Add one to mount a remote directory.
              </p>
              <Button size="sm" onClick={() => setConfigDialog({ mode: "add" })}>
                Add config
              </Button>
            </div>
          ) : (
            <ul className="space-y-1">
              {configs.map((config) => {
                const active = selected === config.name;
                const busy = busyName === config.name;
                return (
                  <li
                    key={config.name}
                    className={cn(
                      "group rounded-md border border-transparent px-2 py-2",
                      active && "border-border bg-accent/50",
                    )}
                  >
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 text-left"
                      onClick={() => setSelected(config.name)}
                    >
                      <span
                        className={cn(
                          "size-2 shrink-0 rounded-full",
                          config.connected ? "bg-emerald-500" : "bg-muted-foreground/40",
                        )}
                        title={config.connected ? "Connected" : "Disconnected"}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{config.name}</span>
                        <span className="block truncate font-mono text-xs text-muted-foreground">
                          {config.host}
                          {config.port === undefined || config.port === 22 ? "" : `:${config.port}`}
                          {" :"}
                          {config.root}
                        </span>
                      </span>
                    </button>
                    <div className="mt-1.5 flex items-center gap-1">
                      <Button
                        variant={config.connected ? "outline" : "default"}
                        size="sm"
                        className="h-6 flex-1 text-xs"
                        disabled={busy}
                        onClick={() => {
                          if (config.connected) void disconnect(config.name);
                          else void connect(config.name);
                        }}
                      >
                        {busy
                          ? "…"
                          : config.connected
                            ? "Disconnect"
                            : "Connect"}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7"
                        disabled={testingName === config.name}
                        aria-label={`Test ${config.name}`}
                        onClick={() => void testConnection(config.name)}
                      >
                        <Icon
                          name="PlugZap"
                          className={cn(
                            "size-3.5 text-muted-foreground",
                            testingName === config.name && "animate-pulse text-foreground",
                          )}
                        />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7"
                        aria-label={`Edit ${config.name}`}
                        onClick={() => setConfigDialog({ mode: "edit", config })}
                      >
                        <Icon name="EditFile" className="size-3.5 text-muted-foreground" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7 text-muted-foreground hover:text-destructive"
                        aria-label={`Delete ${config.name}`}
                        onClick={() => setConfirmDelete(config)}
                      >
                        <Icon name="Trash2" className="size-3.5" />
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <p className="border-t border-border px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
          Passwords are stored server-side. Set one from the config dialog or
          the CLI:{" "}
          <code className="font-mono">
            bb plugin config sshfs set secrets &#39;&#123;"name":&#123;"password":"…"&#125;&#125;&#39;
          </code>
        </p>
          </aside>
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize mounts panel"
            className="group/resizer relative w-1 shrink-0 cursor-col-resize touch-none"
            onPointerDown={onResizeStart}
          >
            <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border transition-colors group-hover/resizer:bg-primary/50" />
          </div>
        </>
      ) : null}

      {/* Remote browser */}
      <main className="flex min-w-0 flex-1 flex-col">
        {!panelOpen ? (
          <div className="flex items-center border-b border-border px-2 py-1.5">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 px-2 text-xs"
              onClick={() => setPanelOpen(true)}
            >
              <Icon name="PanelLeftOpen" className="size-3.5" />
              Mounts
            </Button>
          </div>
        ) : null}
        {connectedTabs.length > 0 ? (
          <div
            className="flex items-center gap-1 overflow-x-auto border-b border-border bg-muted/40 px-2 pt-1.5"
            role="tablist"
            aria-label="Connected mounts"
          >
            {connectedTabs.map((config) => {
              const active = selected === config.name;
              return (
                <button
                  key={config.name}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setSelected(config.name)}
                  title={`${config.host} :${config.root}`}
                  className={cn(
                    "flex h-8 shrink-0 items-center gap-2 rounded-t-md border border-b-0 px-3 text-xs",
                    active
                      ? "border-border bg-card text-foreground"
                      : "border-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                  )}
                >
                  <span className="size-1.5 shrink-0 rounded-full bg-emerald-500" />
                  <span className="max-w-44 truncate">{config.name}</span>
                </button>
              );
            })}
          </div>
        ) : null}
        <div className="min-h-0 flex-1">
          {selectedConfig === null ? (
            <div className="flex h-full items-center justify-center p-6">
              <div className="w-full max-w-sm space-y-2 rounded-lg border border-dashed border-border p-6 text-center">
                <Icon name="FolderOpen" className="mx-auto size-6 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">
                  Pick a mount on the left to browse its files
                  {subPath === "" ? "" : ` (subPath: ${subPath})`}.
                </p>
              </div>
            </div>
          ) : (
            <RemoteBrowser
              // Remount on connect/disconnect so the tree starts fresh.
              key={`${selectedConfig.name}:${selectedConfig.connected}:${browserKey}`}
              config={selectedConfig}
              onStateChange={(connected) => {
                setBrowserKey((value) => value + 1);
                void reload();
                if (!connected) toast.success(`Disconnected ${selectedConfig.name}`);
              }}
            />
          )}
        </div>
      </main>

      <ConfigDialog
        open={configDialog !== null}
        initial={configDialog !== null && configDialog.mode === "edit" ? configDialog.config : null}
        onClose={() => setConfigDialog(null)}
        onSave={saveConfig}
      />
      <ConfirmDialog
        open={confirmDelete !== null}
        title={`Remove ${confirmDelete?.name ?? ""}?`}
        description="The config (host, root) is removed; the connection is closed. Remote files are untouched."
        confirmLabel="Remove"
        onConfirm={() => void deleteConfig()}
        onClose={() => setConfirmDelete(null)}
      />
    </div>
  );
}

function stripConnected(config: ConfigView): SshFsConfig {
  const { connected: _connected, hasPassword: _hasPassword, ...rest } = config;
  return rest;
}

function loadNumber(key: string, fallback: number): number {
  try {
    const raw = window.localStorage.getItem(`sshfs:${key}`);
    if (raw === null) return fallback;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  } catch {
    return fallback;
  }
}

function loadBoolean(key: string, fallback: boolean): boolean {
  try {
    const raw = window.localStorage.getItem(`sshfs:${key}`);
    return raw === null ? fallback : raw !== "0";
  } catch {
    return fallback;
  }
}