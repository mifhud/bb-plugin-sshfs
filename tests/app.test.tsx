// @vitest-environment jsdom
// Frontend behavior: the SSH FS page lists configs and connects, and the
// remote file editor loads, edits, and saves over RPC.
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { rpcContract } from "../contract";
import type { FsEntry } from "../contract";
import { RemoteFileEditor } from "../components/file-editor";
import { resetSessionStore } from "../components/session-store";

const app = await loadPluginApp(() => import("../app"));

// The session store is module-level (it survives navigation by design);
// reset it so tests don't leak remembered dirs/connections into each other.
beforeEach(() => {
  resetSessionStore();
});
afterEach(() => {
  vi.restoreAllMocks();
});

// Handlers the tested surface never calls; renderSlot's rpc map is complete,
// so stubs keep the typed map satisfied and fail loudly if actually reached.
const neverCalled = (): never => {
  throw new Error("unexpected rpc call");
};

const PROD_VIEW = {
  name: "prod",
  host: "example.com",
  user: "deploy",
  root: "/srv/app",
  connected: false,
  hasPassword: false,
};

describe("SSH FS page", () => {
  it("lists mounted configs and connects", async () => {
    const connectCalls: string[] = [];
    let connected = false;
    const slot = renderSlot<{ subPath: string }, typeof rpcContract>(
      app.navPanels[0]!,
      { subPath: "" },
      {
        experimental_rpcContract: rpcContract,
        rpc: {
          configs_list: () => ({ configs: [{ ...PROD_VIEW, connected }] }),
          configs_save: neverCalled,
          secrets_set: neverCalled,
          settings_get: () => ({ sessionRememberSeconds: 600 }),
          mounts_connect: ({ name }: { name: string }) => {
            connectCalls.push(name);
            connected = true;
            return { connected: true, root: "/srv/app", user: "deploy", host: "example.com", port: 22 };
          },
          mounts_disconnect: neverCalled,
          mounts_test: neverCalled,
          fs_list: () => ({ path: ".", entries: [], truncated: false }),
          fs_read: neverCalled,
          fs_write: neverCalled,
          fs_mkdir: neverCalled,
          fs_delete: neverCalled,
          fs_rename: neverCalled,
        },
      },
    );

    await slot.findByText("prod");
    await slot.findByText(/example\.com/);

    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(connectCalls).toEqual(["prod"]));
    slot.lifecycle.unmount();
  });

  it("switches between connected servers with tabs", async () => {
    const listedMounts: string[] = [];
    const slot = renderSlot<{ subPath: string }, typeof rpcContract>(
      app.navPanels[0]!,
      { subPath: "" },
      {
        experimental_rpcContract: rpcContract,
        rpc: {
          configs_list: () => ({
            configs: [
              { ...PROD_VIEW, connected: true },
              { ...PROD_VIEW, name: "stage", host: "stage.example.com", connected: true },
            ],
          }),
          configs_save: neverCalled,
          secrets_set: neverCalled,
          settings_get: () => ({ sessionRememberSeconds: 600 }),
          mounts_connect: neverCalled,
          mounts_disconnect: neverCalled,
          mounts_test: neverCalled,
          fs_list: ({ mount }: { mount: string }) => {
            listedMounts.push(mount);
            return { path: ".", entries: [], truncated: false };
          },
          fs_read: neverCalled,
          fs_write: neverCalled,
          fs_mkdir: neverCalled,
          fs_delete: neverCalled,
          fs_rename: neverCalled,
        },
      },
    );

    // Auto-selects the first connected mount and lists its root.
    await waitFor(() => expect(listedMounts).toEqual(["prod"]));

    // The second server's tab switches the browser to it.
    fireEvent.click(screen.getByRole("tab", { name: /stage/ }));
    await waitFor(() => expect(listedMounts).toEqual(["prod", "stage"]));
    slot.lifecycle.unmount();
  });

  it("restores the last directory when the page remounts", async () => {
    const listedPaths: string[] = [];
    const stubs = {
      configs_list: () => ({ configs: [{ ...PROD_VIEW, connected: true }] }),
      configs_save: neverCalled,
      secrets_set: neverCalled,
      settings_get: () => ({ sessionRememberSeconds: 600 }),
      mounts_connect: neverCalled,
      mounts_disconnect: neverCalled,
      mounts_test: neverCalled,
      fs_list: ({ path }: { path: string }) => {
        listedPaths.push(path);
        return {
          path,
          entries: (
            path === "."
              ? [{ name: "apps", kind: "dir", size: 0, mtimeMs: 1, mode: 0o040755 }]
              : [{ name: "main.ts", kind: "file", size: 5, mtimeMs: 1, mode: 0o100644 }]
          ) as FsEntry[],
          truncated: false,
        };
      },
      fs_read: neverCalled,
      fs_write: neverCalled,
      fs_mkdir: neverCalled,
      fs_delete: neverCalled,
      fs_rename: neverCalled,
    };

    const first = renderSlot<{ subPath: string }, typeof rpcContract>(app.navPanels[0]!, { subPath: "" }, {
      experimental_rpcContract: rpcContract,
      rpc: stubs,
    });
    await first.findByText("apps");
    fireEvent.click(screen.getByRole("button", { name: "apps" })); // the row, not "Expand apps"
    await first.findByText("main.ts");
    first.lifecycle.unmount(); // "navigate away"

    // A fresh page mount restores the directory, not the root.
    const second = renderSlot<{ subPath: string }, typeof rpcContract>(app.navPanels[0]!, { subPath: "" }, {
      experimental_rpcContract: rpcContract,
      rpc: stubs,
    });
    await second.findByText("main.ts");
    expect(listedPaths).toContain("apps");
    second.lifecycle.unmount();
  });

  it("expands folders in place with the chevron; the row click still navigates", async () => {
    const listedPaths: string[] = [];
    const stubs = {
      configs_list: () => ({ configs: [{ ...PROD_VIEW, connected: true }] }),
      configs_save: neverCalled,
      secrets_set: neverCalled,
      settings_get: () => ({ sessionRememberSeconds: 600 }),
      mounts_connect: neverCalled,
      mounts_disconnect: neverCalled,
      mounts_test: neverCalled,
      fs_list: ({ path }: { path: string }) => {
        listedPaths.push(path);
        return {
          path,
          entries: (
            path === "."
              ? [{ name: "apps", kind: "dir", size: 0, mtimeMs: 1, mode: 0o040755 }]
              : path === "apps"
                ? [
                    { name: "src", kind: "dir", size: 0, mtimeMs: 1, mode: 0o040755 },
                    { name: "readme.md", kind: "file", size: 3, mtimeMs: 1, mode: 0o100644 },
                  ]
                : []
          ) as FsEntry[],
          truncated: false,
        };
      },
      fs_read: neverCalled,
      fs_write: neverCalled,
      fs_mkdir: neverCalled,
      fs_delete: neverCalled,
      fs_rename: neverCalled,
    };

    const slot = renderSlot<{ subPath: string }, typeof rpcContract>(app.navPanels[0]!, { subPath: "" }, {
      experimental_rpcContract: rpcContract,
      rpc: stubs,
    });
    await slot.findByText("apps");

    // The chevron expands in place: children appear without changing the path.
    fireEvent.click(screen.getByRole("button", { name: "Expand apps" }));
    await slot.findByText("readme.md");
    expect(listedPaths).toEqual([".", "apps"]);

    // Collapse hides them again.
    fireEvent.click(screen.getByRole("button", { name: "Collapse apps" }));
    await waitFor(() => expect(screen.queryByText("readme.md")).toBeNull());

    // Clicking a folder row navigates into it — including from a subdirectory
    // (paths must stay root-relative, not the plain entry name).
    fireEvent.click(screen.getByRole("button", { name: "apps" }));
    await slot.findByText("readme.md");
    fireEvent.click(screen.getByRole("button", { name: "src" }));
    await slot.findByText("Empty directory");
    expect(listedPaths).toContain("apps/src");
    slot.lifecycle.unmount();
  });

  it("auto-reconnects a mount whose session is still fresh", async () => {
    const connectCalls: string[] = [];
    let connected = false;
    const stubs = {
      configs_list: () => ({ configs: [{ ...PROD_VIEW, connected }] }),
      configs_save: neverCalled,
      secrets_set: neverCalled,
      settings_get: () => ({ sessionRememberSeconds: 600 }),
      mounts_connect: ({ name }: { name: string }) => {
        connectCalls.push(name);
        connected = true;
        return { connected: true, root: "/srv/app", user: "deploy", host: "example.com", port: 22 };
      },
      mounts_disconnect: neverCalled,
      mounts_test: neverCalled,
      fs_list: () => ({ path: ".", entries: [], truncated: false }),
      fs_read: neverCalled,
      fs_write: neverCalled,
      fs_mkdir: neverCalled,
      fs_delete: neverCalled,
      fs_rename: neverCalled,
    };

    // Session: user connects, then the page is left (unmount).
    const first = renderSlot<{ subPath: string }, typeof rpcContract>(app.navPanels[0]!, { subPath: "" }, {
      experimental_rpcContract: rpcContract,
      rpc: stubs,
    });
    await first.findByText("prod");
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(connectCalls).toEqual(["prod"]));
    first.lifecycle.unmount();

    // While away the server idle-closed the connection (connected=false).
    // Returning restores the session automatically — no manual connect.
    connected = false;
    const second = renderSlot<{ subPath: string }, typeof rpcContract>(app.navPanels[0]!, { subPath: "" }, {
      experimental_rpcContract: rpcContract,
      rpc: stubs,
    });
    await waitFor(() => expect(connectCalls).toEqual(["prod", "prod"]));
    second.lifecycle.unmount();
  });

  it("manual disconnect ends the session: no auto-reconnect on return", async () => {
    const connectCalls: string[] = [];
    let connected = false;
    const stubs = {
      configs_list: () => ({ configs: [{ ...PROD_VIEW, connected }] }),
      configs_save: neverCalled,
      secrets_set: neverCalled,
      settings_get: () => ({ sessionRememberSeconds: 600 }),
      mounts_connect: ({ name }: { name: string }) => {
        connectCalls.push(name);
        connected = true;
        return { connected: true, root: "/srv/app", user: "deploy", host: "example.com", port: 22 };
      },
      mounts_disconnect: () => {
        connected = false;
        return { disconnected: true };
      },
      mounts_test: neverCalled,
      fs_list: () => ({ path: ".", entries: [], truncated: false }),
      fs_read: neverCalled,
      fs_write: neverCalled,
      fs_mkdir: neverCalled,
      fs_delete: neverCalled,
      fs_rename: neverCalled,
    };

    const first = renderSlot<{ subPath: string }, typeof rpcContract>(app.navPanels[0]!, { subPath: "" }, {
      experimental_rpcContract: rpcContract,
      rpc: stubs,
    });
    await first.findByText("prod");
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(connectCalls).toEqual(["prod"]));
    await first.findByRole("button", { name: "Disconnect" });
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    // After the manual disconnect the browser area shows the neutral hint,
    // not a connect prompt.
    await first.findByText(/is not connected\. Connect it from the mounts list/);
    first.lifecycle.unmount();

    // Returning reconnects nothing: the session ended when the user
    // disconnected manually, despite the fresh remember window.
    connected = false;
    const second = renderSlot<{ subPath: string }, typeof rpcContract>(app.navPanels[0]!, { subPath: "" }, {
      experimental_rpcContract: rpcContract,
      rpc: stubs,
    });
    await second.findByText(/Pick a mount on the left/);
    const { promise: settle, resolve: done } = Promise.withResolvers<void>();
    setTimeout(done, 50);
    await settle;
    expect(connectCalls).toEqual(["prod"]);
    second.lifecycle.unmount();
  });

  it("forgets the remembered directory once the session window elapsed", async () => {
    const listedPaths: string[] = [];
    let connected = false;
    const stubs = {
      configs_list: () => ({ configs: [{ ...PROD_VIEW, connected }] }),
      configs_save: neverCalled,
      secrets_set: neverCalled,
      settings_get: () => ({ sessionRememberSeconds: 600 }),
      mounts_connect: () => {
        connected = true;
        return { connected: true, root: "/srv/app", user: "deploy", host: "example.com", port: 22 };
      },
      mounts_disconnect: neverCalled,
      mounts_test: neverCalled,
      fs_list: ({ path }: { path: string }) => {
        listedPaths.push(path);
        return {
          path,
          entries: (
            path === "."
              ? [{ name: "apps", kind: "dir", size: 0, mtimeMs: 1, mode: 0o040755 }]
              : []
          ) as FsEntry[],
          truncated: false,
        };
      },
      fs_read: neverCalled,
      fs_write: neverCalled,
      fs_mkdir: neverCalled,
      fs_delete: neverCalled,
      fs_rename: neverCalled,
    };

    let clock = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => clock);

    const first = renderSlot<{ subPath: string }, typeof rpcContract>(app.navPanels[0]!, { subPath: "" }, {
      experimental_rpcContract: rpcContract,
      rpc: stubs,
    });
    await first.findByText("prod");
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await first.findByText("apps");
    fireEvent.click(screen.getByRole("button", { name: "apps" }));
    await waitFor(() => expect(listedPaths).toContain("apps"));
    first.lifecycle.unmount();

    // Away longer than `sessionRememberSeconds`: idle-closed and expired.
    connected = false;
    clock += 601_000;
    listedPaths.length = 0;

    const second = renderSlot<{ subPath: string }, typeof rpcContract>(app.navPanels[0]!, { subPath: "" }, {
      experimental_rpcContract: rpcContract,
      rpc: stubs,
    });
    await second.findByText(/Pick a mount on the left/);
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await second.findByText("apps");
    // Reconnecting lands on the mount root, not the stale directory.
    expect(listedPaths).toEqual(["."]);
    second.lifecycle.unmount();
  });

  it("shows a hint when no configs exist", async () => {
    const slot = renderSlot<{ subPath: string }, typeof rpcContract>(
      app.navPanels[0]!,
      { subPath: "" },
      {
        experimental_rpcContract: rpcContract,
        rpc: {
          configs_list: () => ({ configs: [] }),
          configs_save: neverCalled,
          secrets_set: neverCalled,
          settings_get: () => ({ sessionRememberSeconds: 600 }),
          mounts_connect: neverCalled,
          mounts_disconnect: neverCalled,
          mounts_test: neverCalled,
          fs_list: neverCalled,
          fs_read: neverCalled,
          fs_write: neverCalled,
          fs_mkdir: neverCalled,
          fs_delete: neverCalled,
          fs_rename: neverCalled,
        },
      },
    );
    await slot.findByText(/No SSH FS configs yet/);
    slot.lifecycle.unmount();
  });
});

describe("Remote file editor", () => {
  it("loads, edits, and saves a file over RPC", async () => {
    const writes: string[] = [];
    const slot = renderSlot<
      { subPath: string; params: unknown },
      typeof rpcContract
    >(
      { component: RemoteFileEditor },
      { subPath: "", params: { mount: "prod", path: "README.md" } },
      {
        experimental_rpcContract: rpcContract,
        rpc: {
          configs_list: neverCalled,
          configs_save: neverCalled,
          secrets_set: neverCalled,
          settings_get: neverCalled,
          mounts_connect: neverCalled,
          mounts_disconnect: neverCalled,
          mounts_test: neverCalled,
          fs_list: neverCalled,
          fs_read: () => ({
            path: "README.md",
            content: "# Hello\n",
            size: 8,
            mtimeMs: 1_700_000_000_000,
            isBinary: false,
          }),
          fs_write: ({ content }: { content: string }) => {
            writes.push(content);
            return { size: content.length, mtimeMs: 1_700_000_001_000 };
          },
          fs_mkdir: neverCalled,
          fs_delete: neverCalled,
          fs_rename: neverCalled,
        },
      },
    );

    await slot.findByText("prod:README.md");
    const textarea = screen.getByRole("textbox", { name: "Edit README.md" });
    fireEvent.change(textarea, { target: { value: "# Hello world\n" } });

    const save = screen.getByRole("button", { name: "Save" });
    expect((save as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(writes).toEqual(["# Hello world\n"]));
    slot.lifecycle.unmount();
  });

  it("marks binary files as uneditable", async () => {
    const slot = renderSlot<
      { subPath: string; params: unknown },
      typeof rpcContract
    >(
      { component: RemoteFileEditor },
      { subPath: "", params: { mount: "prod", path: "logo.png" } },
      {
        experimental_rpcContract: rpcContract,
        rpc: {
          configs_list: neverCalled,
          configs_save: neverCalled,
          secrets_set: neverCalled,
          settings_get: neverCalled,
          mounts_connect: neverCalled,
          mounts_disconnect: neverCalled,
          mounts_test: neverCalled,
          fs_list: neverCalled,
          fs_read: () => ({
            path: "logo.png",
            content: "",
            size: 4096,
            mtimeMs: 1_700_000_000_000,
            isBinary: true,
          }),
          fs_write: neverCalled,
          fs_mkdir: neverCalled,
          fs_delete: neverCalled,
          fs_rename: neverCalled,
        },
      },
    );
    await slot.findByText(/binary file/i);
    expect(screen.queryByRole("textbox")).toBeNull();
    slot.lifecycle.unmount();
  });
});