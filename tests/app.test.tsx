// @vitest-environment jsdom
// Frontend behavior: the SSH FS page lists configs and connects, and the
// remote file editor loads, edits, and saves over RPC.
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { rpcContract } from "../contract";
import type { FsEntry } from "../contract";
import { RemoteFileEditor } from "../components/file-editor";
import { getDirtyDraft, resetDraftStore, setDirtyDraft } from "../components/draft-store";
import { resetSessionStore } from "../components/session-store";

const app = await loadPluginApp(() => import("../app"));

// Radix context menus position with floating-ui, which needs DOM geometry
// APIs jsdom lacks; no-op stubs keep the menu renderable in tests.
if (typeof globalThis.ResizeObserver === "undefined") {
  class JsdomResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver =
    JsdomResizeObserver as unknown as typeof ResizeObserver;
}
if (typeof DOMRect === "function") {
  // jsdom's DOMRect lacks the static factory Radix uses for virtual anchors.
  const domRect = DOMRect as typeof DOMRect & {
    fromRect?: (rect: DOMRectInit) => DOMRect;
  };
  const fromRect = (rect: DOMRectInit): DOMRect =>
    new DOMRect(rect.x ?? 0, rect.y ?? 0, rect.width ?? 0, rect.height ?? 0);
  if (domRect.fromRect === undefined) {
    domRect.fromRect = fromRect;
  }
}

// The session store is module-level (it survives navigation by design);
// reset it so tests don't leak remembered dirs/connections into each other.
beforeEach(() => {
  resetSessionStore();
  resetDraftStore();
  window.localStorage.clear();
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

  it("asks what to do with an unsaved draft when reopening the same file", async () => {
    const stubs = {
      configs_list: () => ({ configs: [{ ...PROD_VIEW, connected: true }] }),
      configs_save: neverCalled,
      secrets_set: neverCalled,
      settings_get: () => ({ sessionRememberSeconds: 600 }),
      mounts_connect: neverCalled,
      mounts_disconnect: neverCalled,
      mounts_test: neverCalled,
      fs_list: () => ({
        path: ".",
        entries: [{ name: "a.txt", kind: "file", size: 1, mtimeMs: 1, mode: 0o100644 }] as FsEntry[],
        truncated: false,
      }),
      fs_read: neverCalled,
      fs_write: neverCalled,
      fs_mkdir: neverCalled,
      fs_delete: neverCalled,
      fs_rename: neverCalled,
    };

    // Keep draft: the file opens and the draft stays for the editor to restore.
    setDirtyDraft({ mount: "prod", path: "a.txt", content: "edited" });
    const slot = renderSlot<{ subPath: string }, typeof rpcContract>(
      app.navPanels[0]!,
      { subPath: "" },
      { experimental_rpcContract: rpcContract, rpc: stubs },
    );
    await slot.findByText("a.txt");
    fireEvent.click(screen.getByRole("button", { name: "a.txt" }));
    await slot.findByText(/unsaved draft/);
    fireEvent.click(screen.getByRole("button", { name: "Keep draft" }));
    await waitFor(() => expect(slot.inspection.experimental_tabOpenCalls).toHaveLength(1));
    expect(getDirtyDraft("prod", "a.txt")?.content).toBe("edited");
    slot.lifecycle.unmount();

    // Discard: the draft is cleared and the file opens fresh.
    setDirtyDraft({ mount: "prod", path: "a.txt", content: "edited" });
    const second = renderSlot<{ subPath: string }, typeof rpcContract>(
      app.navPanels[0]!,
      { subPath: "" },
      { experimental_rpcContract: rpcContract, rpc: stubs },
    );
    await second.findByText("a.txt");
    fireEvent.click(screen.getByRole("button", { name: "a.txt" }));
    await second.findByText(/unsaved draft/);
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(getDirtyDraft("prod", "a.txt")).toBeUndefined());
    second.lifecycle.unmount();
  });

  it("sorts the listing by name and last modified", async () => {
    const stubs = {
      configs_list: () => ({ configs: [{ ...PROD_VIEW, connected: true }] }),
      configs_save: neverCalled,
      secrets_set: neverCalled,
      settings_get: () => ({ sessionRememberSeconds: 600 }),
      mounts_connect: neverCalled,
      mounts_disconnect: neverCalled,
      mounts_test: neverCalled,
      fs_list: () => ({
        path: ".",
        entries: [
          { name: "b.txt", kind: "file", size: 1, mtimeMs: 3, mode: 0o100644 },
          { name: "a.txt", kind: "file", size: 2, mtimeMs: 1, mode: 0o100644 },
          { name: "c.txt", kind: "file", size: 3, mtimeMs: 2, mode: 0o100644 },
        ] as FsEntry[],
        truncated: false,
      }),
      fs_read: neverCalled,
      fs_write: neverCalled,
      fs_mkdir: neverCalled,
      fs_delete: neverCalled,
      fs_rename: neverCalled,
    };
    const names = () =>
      screen.getAllByRole("button", { name: /\.txt$/ }).map((button) => button.textContent);

    const slot = renderSlot<{ subPath: string }, typeof rpcContract>(app.navPanels[0]!, { subPath: "" }, {
      experimental_rpcContract: rpcContract,
      rpc: stubs,
    });
    await slot.findByText("a.txt");
    expect(names()).toEqual(["a.txt", "b.txt", "c.txt"]); // default: name asc

    fireEvent.click(screen.getByRole("button", { name: "Sort by name" }));
    await waitFor(() => expect(names()).toEqual(["c.txt", "b.txt", "a.txt"]));

    // Last modified defaults to newest-first, toggles to oldest-first.
    fireEvent.click(screen.getByRole("button", { name: "Sort by last modified" }));
    await waitFor(() => expect(names()).toEqual(["b.txt", "c.txt", "a.txt"]));
    fireEvent.click(screen.getByRole("button", { name: "Sort by last modified" }));
    await waitFor(() => expect(names()).toEqual(["a.txt", "c.txt", "b.txt"]));
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

describe("SSH FS browser", () => {
  it("creates files and folders from the right-click context menu", async () => {
    const writes: Array<{ path: string; content: string }> = [];
    const mkdirs: string[] = [];
    const stubs = {
      configs_list: () => ({ configs: [{ ...PROD_VIEW, connected: true }] }),
      configs_save: neverCalled,
      secrets_set: neverCalled,
      settings_get: () => ({ sessionRememberSeconds: 600 }),
      mounts_connect: neverCalled,
      mounts_disconnect: neverCalled,
      mounts_test: neverCalled,
      fs_list: () => ({
        path: ".",
        entries: [
          { name: "a.txt", kind: "file", size: 1, mtimeMs: 1, mode: 0o100644 },
          { name: "docs", kind: "dir", size: 0, mtimeMs: 1, mode: 0o040755 },
        ] as FsEntry[],
        truncated: false,
      }),
      fs_read: neverCalled,
      fs_write: ({ path, content }: { path: string; content: string }) => {
        writes.push({ path, content });
        return { size: content.length, mtimeMs: 2 };
      },
      fs_mkdir: ({ path }: { path: string }) => {
        mkdirs.push(path);
        return { created: true };
      },
      fs_delete: neverCalled,
      fs_rename: neverCalled,
    };

    const slot = renderSlot<{ subPath: string }, typeof rpcContract>(
      app.navPanels[0]!,
      { subPath: "" },
      { experimental_rpcContract: rpcContract, rpc: stubs },
    );
    await slot.findByText("a.txt");

    // Right-clicking a file opens the create menu; the file's parent dir is
    // the current directory (root), so the description shows "/".
    fireEvent.contextMenu(screen.getByRole("button", { name: "a.txt" }));
    await screen.findByRole("menuitem", { name: "New file" });
    fireEvent.click(screen.getByRole("menuitem", { name: "New file" }));
    expect(await screen.findByText("In /")).toBeTruthy();
    // Entering a name creates the file in the right-clicked folder's parent
    // directory — here, the root (same as cwd).
    fireEvent.change(screen.getByRole("textbox", { name: "New file" }), {
      target: { value: "notes.txt" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(writes).toEqual([{ path: "notes.txt", content: "" }]));

    // Right-clicking a folder creates inside that folder, not cwd.
    fireEvent.contextMenu(screen.getByRole("button", { name: "docs" }));
    await screen.findByRole("menuitem", { name: "New folder" });
    fireEvent.click(screen.getByRole("menuitem", { name: "New folder" }));
    expect(await screen.findByText("In docs")).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "New folder" }), {
      target: { value: "src" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(mkdirs).toEqual(["docs/src"]));
    slot.lifecycle.unmount();
  });

  it("creates a file in the right-clicked folder (not cwd)", async () => {
    const writes: Array<{ path: string; content: string }> = [];
    const stubs = {
      configs_list: () => ({ configs: [{ ...PROD_VIEW, connected: true }] }),
      configs_save: neverCalled,
      secrets_set: neverCalled,
      settings_get: () => ({ sessionRememberSeconds: 600 }),
      mounts_connect: neverCalled,
      mounts_disconnect: neverCalled,
      mounts_test: neverCalled,
      fs_list: () => ({
        path: ".",
        entries: [
          { name: "docs", kind: "dir", size: 0, mtimeMs: 1, mode: 0o040755 },
        ] as FsEntry[],
        truncated: false,
      }),
      fs_read: neverCalled,
      fs_write: ({ path, content }: { path: string; content: string }) => {
        writes.push({ path, content });
        return { size: content.length, mtimeMs: 2 };
      },
      fs_mkdir: neverCalled,
      fs_delete: neverCalled,
      fs_rename: neverCalled,
    };

    const slot = renderSlot<{ subPath: string }, typeof rpcContract>(
      app.navPanels[0]!,
      { subPath: "" },
      { experimental_rpcContract: rpcContract, rpc: stubs },
    );
    await slot.findByText("docs");

    // Right-click the folder, choose New file, and verify it lands inside docs/.
    fireEvent.contextMenu(screen.getByRole("button", { name: "docs" }));
    await screen.findByRole("menuitem", { name: "New file" });
    fireEvent.click(screen.getByRole("menuitem", { name: "New file" }));
    expect(await screen.findByText("In docs")).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "New file" }), {
      target: { value: "readme.md" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(writes).toEqual([{ path: "docs/readme.md", content: "" }]));
    slot.lifecycle.unmount();
  });

  it("creates in cwd when right-clicking empty space in the listing", async () => {
    const writes: Array<{ path: string; content: string }> = [];
    const stubs = {
      configs_list: () => ({ configs: [{ ...PROD_VIEW, connected: true }] }),
      configs_save: neverCalled,
      secrets_set: neverCalled,
      settings_get: () => ({ sessionRememberSeconds: 600 }),
      mounts_connect: neverCalled,
      mounts_disconnect: neverCalled,
      mounts_test: neverCalled,
      fs_list: () => ({
        path: ".",
        entries: [
          { name: "docs", kind: "dir", size: 0, mtimeMs: 1, mode: 0o040755 },
          { name: "app.txt", kind: "file", size: 1, mtimeMs: 1, mode: 0o100644 },
        ] as FsEntry[],
        truncated: false,
      }),
      fs_read: neverCalled,
      fs_write: ({ path, content }: { path: string; content: string }) => {
        writes.push({ path, content });
        return { size: content.length, mtimeMs: 2 };
      },
      fs_mkdir: neverCalled,
      fs_delete: neverCalled,
      fs_rename: neverCalled,
    };

    const slot = renderSlot<{ subPath: string }, typeof rpcContract>(
      app.navPanels[0]!,
      { subPath: "" },
      { experimental_rpcContract: rpcContract, rpc: stubs },
    );
    await slot.findByText("docs");

    // Right-click the list container (empty space) — contextFolder stays null,
    // so the create target is the current directory.
    // The browser listing ul has "divide-y", the mount panel ul has "space-y-1".
    const lists = screen.getAllByRole("list");
    const list = lists.find((el) => (el as HTMLElement).className.includes("divide-y"))!;
    fireEvent.contextMenu(list);
    await screen.findByRole("menuitem", { name: "New file" });
    fireEvent.click(screen.getByRole("menuitem", { name: "New file" }));
    expect(await screen.findByText("In /")).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "New file" }), {
      target: { value: "root.txt" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(writes).toEqual([{ path: "root.txt", content: "" }]));
    slot.lifecycle.unmount();
  });

  it("doesn't get stuck loading after creating a file in an expanded folder", async () => {
    const writes: Array<{ path: string; content: string }> = [];
    const stubs = {
      configs_list: () => ({ configs: [{ ...PROD_VIEW, connected: true }] }),
      configs_save: neverCalled,
      secrets_set: neverCalled,
      settings_get: () => ({ sessionRememberSeconds: 600 }),
      mounts_connect: neverCalled,
      mounts_disconnect: neverCalled,
      mounts_test: neverCalled,
      fs_list: ({ path }: { mount: string; path: string }) => {
        if (path === "." || path === "") {
          return {
            path: ".",
            entries: [
              { name: "docs", kind: "dir", size: 0, mtimeMs: 1, mode: 0o040755 },
            ] as FsEntry[],
            truncated: false,
          };
        }
        // Expanded subfolder children.
        return {
          path,
          entries: [
            { name: "child.txt", kind: "file", size: 1, mtimeMs: 1, mode: 0o100644 },
          ] as FsEntry[],
          truncated: false,
        };
      },
      fs_read: neverCalled,
      fs_write: ({ path, content }: { path: string; content: string }) => {
        writes.push({ path, content });
        return { size: content.length, mtimeMs: 2 };
      },
      fs_mkdir: neverCalled,
      fs_delete: neverCalled,
      fs_rename: neverCalled,
    };

    const slot = renderSlot<{ subPath: string }, typeof rpcContract>(
      app.navPanels[0]!,
      { subPath: "" },
      { experimental_rpcContract: rpcContract, rpc: stubs },
    );
    await slot.findByText("docs");

    // Expand the folder so its children load in place.
    fireEvent.click(screen.getByRole("button", { name: "Expand docs" }));
    await screen.findByText("child.txt");

    // Right-click the folder, create a file inside it — this triggers
    // invalidate(), which must clear the children cache so the expanded
    // folder's children reload instead of staying in "Loading".
    fireEvent.contextMenu(screen.getByRole("button", { name: "docs" }));
    await screen.findByRole("menuitem", { name: "New file" });
    fireEvent.click(screen.getByRole("menuitem", { name: "New file" }));
    fireEvent.change(screen.getByRole("textbox", { name: "New file" }), {
      target: { value: "newfile.txt" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(writes).toEqual([{ path: "docs/newfile.txt", content: "" }]));

    // The expanded folder must still show its children, not a stuck "Loading".
    await screen.findByText("child.txt");
    expect(screen.queryByText(/Loading docs/)).toBeNull();
    slot.lifecycle.unmount();
  });

  it("filters the listing by file and folder name", async () => {
    const stubs = {
      configs_list: () => ({ configs: [{ ...PROD_VIEW, connected: true }] }),
      configs_save: neverCalled,
      secrets_set: neverCalled,
      settings_get: () => ({ sessionRememberSeconds: 600 }),
      mounts_connect: neverCalled,
      mounts_disconnect: neverCalled,
      mounts_test: neverCalled,
      fs_list: () => ({
        path: ".",
        entries: [
          { name: "alpha.txt", kind: "file", size: 1, mtimeMs: 1, mode: 0o100644 },
          { name: "apps", kind: "dir", size: 0, mtimeMs: 1, mode: 0o040755 },
          { name: "cfg.ini", kind: "file", size: 2, mtimeMs: 1, mode: 0o100644 },
          { name: "docs", kind: "dir", size: 0, mtimeMs: 1, mode: 0o040755 },
        ] as FsEntry[],
        truncated: false,
      }),
      fs_read: neverCalled,
      fs_write: neverCalled,
      fs_mkdir: neverCalled,
      fs_delete: neverCalled,
      fs_rename: neverCalled,
    };

    const slot = renderSlot<{ subPath: string }, typeof rpcContract>(
      app.navPanels[0]!,
      { subPath: "" },
      { experimental_rpcContract: rpcContract, rpc: stubs },
    );
    await slot.findByText("alpha.txt");

    // Files and folders both filter; non-matching entries disappear.
    const filterInput = screen.getByRole("textbox", { name: "Filter by name" });
    fireEvent.change(filterInput, { target: { value: "a" } });
    await waitFor(() => expect(screen.getByText("alpha.txt")).toBeTruthy());
    expect(screen.getByText("apps")).toBeTruthy();
    expect(screen.queryByText("cfg.ini")).toBeNull();
    expect(screen.queryByText("docs")).toBeNull();

    // Clearing restores the full listing.
    fireEvent.click(screen.getByRole("button", { name: "Clear filter" }));
    await waitFor(() => expect(screen.getByText("cfg.ini")).toBeTruthy());

    // A filter without hits shows the no-matches state.
    fireEvent.change(filterInput, { target: { value: "zzz" } });
    await waitFor(() => expect(screen.getByText(/No matches for/)).toBeTruthy());
    expect(screen.queryByText("apps")).toBeNull();
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

  it("restores an unsaved draft when the tab remounts", async () => {
    const props = { subPath: "", params: { mount: "prod", path: "README.md" } };
    const rpc = {
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
      fs_write: () => ({ size: 0, mtimeMs: 1_700_000_001_000 }),
      fs_mkdir: neverCalled,
      fs_delete: neverCalled,
      fs_rename: neverCalled,
    };

    const first = renderSlot<{ subPath: string; params: unknown }, typeof rpcContract>(
      { component: RemoteFileEditor },
      props,
      { experimental_rpcContract: rpcContract, rpc },
    );
    await first.findByText("prod:README.md");
    const textarea = screen.getByRole("textbox", { name: "Edit README.md" });
    fireEvent.change(textarea, { target: { value: "# Hello world\n" } });
    expect(getDirtyDraft("prod", "README.md")?.content).toBe("# Hello world\n");
    first.lifecycle.unmount(); // "switch away to another tab"

    const second = renderSlot<{ subPath: string; params: unknown }, typeof rpcContract>(
      { component: RemoteFileEditor },
      props,
      { experimental_rpcContract: rpcContract, rpc },
    );
    await second.findByText("prod:README.md");
    const restored = screen.getByRole("textbox", { name: "Edit README.md" }) as HTMLTextAreaElement;
    expect(restored.value).toBe("# Hello world\n");
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(false);
    second.lifecycle.unmount();
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

  it("finds, navigates, and replaces like the Monaco widget", async () => {
    const rpc = {
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
        content: "# Hello world\nhello again\n",
        size: 27,
        mtimeMs: 1_700_000_000_000,
        isBinary: false,
      }),
      fs_write: neverCalled,
      fs_mkdir: neverCalled,
      fs_delete: neverCalled,
      fs_rename: neverCalled,
    };
    const slot = renderSlot<{ subPath: string; params: unknown }, typeof rpcContract>(
      { component: RemoteFileEditor },
      { subPath: "", params: { mount: "prod", path: "README.md" } },
      { experimental_rpcContract: rpcContract, rpc },
    );
    await slot.findByText("prod:README.md");
    const textarea = screen.getByRole("textbox", { name: "Edit README.md" });

    // Ctrl+F opens the find bar; both matches are highlighted and counted.
    fireEvent.keyDown(textarea, { key: "f", ctrlKey: true });
    const findInput = await screen.findByRole("textbox", { name: "Find" });
    fireEvent.change(findInput, { target: { value: "hello" } });
    await waitFor(() => expect(screen.getByText("1/2")).toBeTruthy());
    expect(document.querySelectorAll("mark")).toHaveLength(2);
    // The textarea turns transparent so the highlight layer shows through.
    expect(textarea.className).toContain("bg-transparent");

    // Enter jumps to the next match.
    fireEvent.keyDown(findInput, { key: "Enter" });
    await waitFor(() => expect(screen.getByText("2/2")).toBeTruthy());

    // Match case narrows the search to one occurrence.
    fireEvent.click(screen.getByRole("button", { name: "Match case" }));
    await waitFor(() => expect(screen.getByText("1/1")).toBeTruthy());

    // Ctrl+H reveals the replace row; Replace swaps only the active match.
    fireEvent.keyDown(textarea, { key: "h", ctrlKey: true });
    const replaceInput = await screen.findByRole("textbox", { name: "Replace" });
    fireEvent.change(replaceInput, { target: { value: "Hi" } });
    fireEvent.click(screen.getByRole("button", { name: "Replace" }));
    await waitFor(() =>
      expect((textarea as HTMLTextAreaElement).value).toBe("# Hello world\nHi again\n"),
    );

    // Replace All swaps every remaining match.
    fireEvent.change(findInput, { target: { value: "o" } });
    fireEvent.change(replaceInput, { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "Replace all" }));
    await waitFor(() =>
      expect((textarea as HTMLTextAreaElement).value).toBe("# Hell0 w0rld\nHi again\n"),
    );

    // Escape closes the widget and removes the highlights.
    fireEvent.keyDown(findInput, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Find" })).toBeNull());
    expect(document.querySelectorAll("mark")).toHaveLength(0);
    slot.lifecycle.unmount();
  });

  it("shows the regex toggle and invalid-expression state", async () => {
    const rpc = {
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
        content: "cat bat cot\n",
        size: 12,
        mtimeMs: 1_700_000_000_000,
        isBinary: false,
      }),
      fs_write: neverCalled,
      fs_mkdir: neverCalled,
      fs_delete: neverCalled,
      fs_rename: neverCalled,
    };
    const slot = renderSlot<{ subPath: string; params: unknown }, typeof rpcContract>(
      { component: RemoteFileEditor },
      { subPath: "", params: { mount: "prod", path: "README.md" } },
      { experimental_rpcContract: rpcContract, rpc },
    );
    await slot.findByText("prod:README.md");
    const textarea = screen.getByRole("textbox", { name: "Edit README.md" });
    fireEvent.keyDown(textarea, { key: "f", ctrlKey: true });
    const findInput = await screen.findByRole("textbox", { name: "Find" });

    // Regex mode matches both c.t words; the regex toggle reports state.
    fireEvent.click(screen.getByRole("button", { name: "Use regular expression" }));
    fireEvent.change(findInput, { target: { value: "c.t" } });
    await waitFor(() => expect(screen.getByText("1/2")).toBeTruthy());

    // An unterminated group shows the invalid state instead of a count.
    fireEvent.change(findInput, { target: { value: "(" } });
    await waitFor(() => expect(screen.getByText("Invalid expr.")).toBeTruthy());
    expect(document.querySelectorAll("mark")).toHaveLength(0);
    slot.lifecycle.unmount();
  });

  it("front-truncates the toolbar path when it overflows", async () => {
    // Functional ResizeObserver that captures callbacks keyed by observed element
    const roCallbacks = new Map<Element, () => void>();
    const OriginalRO = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class MockRO {
      cb: () => void;
      constructor(cb: ResizeObserverCallback) {
        this.cb = cb as () => void;
      }
      observe(target: Element) {
        roCallbacks.set(target, this.cb);
      }
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;

    try {
      const longMount = "devops@10.0.7.127";
      const longPath = "home/devops/jns_65/filevalidator/test1.txt";
      const fullPath = `${longMount}:${longPath}`;

      const slot = renderSlot<{ subPath: string; params: unknown }, typeof rpcContract>(
        { component: RemoteFileEditor },
        { subPath: "", params: { mount: longMount, path: longPath } },
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
              path: longPath,
              content: "hello world\n",
              size: 12,
              mtimeMs: 1_700_000_000_000,
              isBinary: false,
            }),
            fs_write: neverCalled,
            fs_mkdir: neverCalled,
            fs_delete: neverCalled,
            fs_rename: neverCalled,
          },
        },
      );

      // Initial render: full path shown (jsdom dims are 0, frontTruncate returns as-is)
      await slot.findByText(fullPath);

      // Locate the path span (title={fullPath}) and its hidden measurement sibling
      const pathSpan = screen.getByTitle(fullPath) as HTMLElement;
      const measureSpan = pathSpan.nextElementSibling as HTMLElement;

      // Simulate overflow: 80 px toolbar, measure span reports width per character
      Object.defineProperty(pathSpan, "clientWidth", { value: 80, configurable: true });
      Object.defineProperty(measureSpan, "scrollWidth", {
        configurable: true,
        get() {
          return (measureSpan.textContent || "").length * 8;
        },
      });

      // Trigger the path-truncation ResizeObserver callback
      const cb = roCallbacks.get(pathSpan);
      expect(cb).toBeDefined();
      cb!();

      // Toolbar text is now front-truncated: `…` prefix, filename end kept
      await waitFor(() => {
        expect(pathSpan.textContent).not.toBe(fullPath);
      });
      expect(pathSpan.textContent).toMatch(/^…/);
      expect(pathSpan.textContent).toContain("test1.txt");
      expect(pathSpan.textContent).not.toMatch(/^devops/);

      slot.lifecycle.unmount();
    } finally {
      globalThis.ResizeObserver = OriginalRO;
    }
  });

  it("hides non-essential find toggles when the bar is narrow", async () => {
    const roCallbacks = new Map<Element, () => void>();
    const OriginalRO = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class MockRO {
      cb: () => void;
      constructor(cb: ResizeObserverCallback) {
        this.cb = cb as () => void;
      }
      observe(target: Element) {
        roCallbacks.set(target, this.cb);
      }
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;

    try {
      const slot = renderSlot<{ subPath: string; params: unknown }, typeof rpcContract>(
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
              content: "# Hello world\nhello again\n",
              size: 27,
              mtimeMs: 1_700_000_000_000,
              isBinary: false,
            }),
            fs_write: neverCalled,
            fs_mkdir: neverCalled,
            fs_delete: neverCalled,
            fs_rename: neverCalled,
          },
        },
      );

      await slot.findByText("prod:README.md");
      const textarea = screen.getByRole("textbox", { name: "Edit README.md" });

      // Open the find bar (Ctrl+F) and expand the replace row
      fireEvent.keyDown(textarea, { key: "f", ctrlKey: true });
      const findInput = await screen.findByRole("textbox", { name: "Find" });
      fireEvent.click(screen.getByRole("button", { name: "Show replace" }));

      // Non-essential toggles are visible (not compact)
      const matchCase = screen.getByRole("button", { name: "Match case" });
      const wholeWord = screen.getByRole("button", { name: "Match whole word" });
      const useRegex = screen.getByRole("button", { name: "Use regular expression" });
      const preserveCase = screen.getByRole("button", { name: "Preserve case" });
      const replaceBtn = screen.getByRole("button", { name: "Replace" });
      const replaceAllBtn = screen.getByRole("button", { name: "Replace all" });

      expect(matchCase.className).toContain("sm:inline-flex");
      expect(wholeWord.className).toContain("sm:inline-flex");
      expect(useRegex.className).toContain("sm:inline-flex");
      expect(preserveCase.className).toContain("sm:inline-flex");
      expect(replaceBtn.className).toContain("sm:inline-flex");
      expect(replaceAllBtn.className).toContain("sm:inline-flex");

      // Locate the find-bar container and simulate a narrow width (< 320 px)
      const findBar = findInput.closest(
        'div[class*="grid"][class*="gap-0.5"][class*="border-b"]',
      ) as HTMLElement;
      expect(findBar).not.toBeNull();
      // With replace shown, the show-replace toggle stays on the left of the find
      // row (it does NOT move to a middle row), and the replace row starts with a
      // 28px spacer so both fields align at the same offset. The two input fields
      // share the same capped width, so their lengths stay equal.
      const toggleBtn = screen.getByRole("button", { name: "Hide replace" });
      const rows = Array.from(findBar.children) as HTMLElement[];
      const findRowEl = (findInput.closest("div") as HTMLElement).parentElement as HTMLElement;
      const replaceInput = screen.getByRole("textbox", { name: "Replace" });
      const replaceRowEl = (replaceInput.closest("div") as HTMLElement).parentElement as HTMLElement;
      // find row first, replace row second — no separate middle row.
      expect(rows.indexOf(findRowEl)).toBe(0);
      expect(rows.indexOf(replaceRowEl)).toBe(1);
      // Toggle is the first element of the find row; the replace row starts with a spacer.
      expect(Array.from(findRowEl.children).indexOf(toggleBtn)).toBe(0);
      expect((replaceRowEl.children[0] as HTMLElement).className).toBe("w-7");
      // Find & Replace inputs are equal width and left-aligned to the same offset.
      const findWrapper = findRowEl.children[1] as HTMLElement;
      const replaceWrapper = replaceRowEl.children[1] as HTMLElement;
      expect(findWrapper.className).toBe(replaceWrapper.className);
      Object.defineProperty(findBar, "clientWidth", { value: 200, configurable: true });

      // Trigger the compact-mode ResizeObserver callback
      const cb = roCallbacks.get(findBar);
      expect(cb).toBeDefined();
      cb!();

      // Non-essential toggles are now hidden (compact mode)
      await waitFor(() => {
        expect(matchCase.className).not.toContain("sm:inline-flex");
      });
      expect(wholeWord.className).not.toContain("sm:inline-flex");
      expect(useRegex.className).not.toContain("sm:inline-flex");
      expect(preserveCase.className).not.toContain("sm:inline-flex");
      expect(replaceBtn.className).not.toContain("sm:inline-flex");
      expect(replaceAllBtn.className).not.toContain("sm:inline-flex");

      // Essential buttons remain present
      expect(screen.getByRole("button", { name: "Previous match" })).toBeDefined();
      expect(screen.getByRole("button", { name: "Next match" })).toBeDefined();
      expect(screen.getByRole("button", { name: "Hide replace" })).toBeDefined();
      expect(screen.getByRole("button", { name: "Close find" })).toBeDefined();

      slot.lifecycle.unmount();
    } finally {
      globalThis.ResizeObserver = OriginalRO;
    }
  });

  it("gives tooltips to essential find-bar icons and places show-replace before the find field", async () => {
    const slot = renderSlot<{ subPath: string; params: unknown }, typeof rpcContract>(
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
          fs_write: neverCalled,
          fs_mkdir: neverCalled,
          fs_delete: neverCalled,
          fs_rename: neverCalled,
        },
      },
    );

    await slot.findByText("prod:README.md");
    const textarea = screen.getByRole("textbox", { name: "Edit README.md" });
    fireEvent.keyDown(textarea, { key: "f", ctrlKey: true });
    await screen.findByRole("textbox", { name: "Find" });

    // Every icon button has a tooltip
    expect(screen.getByRole("button", { name: "Previous match" }).getAttribute("title")).toBe("Previous match (Enter)");
    expect(screen.getByRole("button", { name: "Next match" }).getAttribute("title")).toBe("Next match (Enter)");
    expect(screen.getByRole("button", { name: "Close find" }).getAttribute("title")).toBe("Close (Escape)");
    expect(screen.getByRole("button", { name: "Show replace" }).getAttribute("title")).toBe("Show replace (Ctrl+H)");

    // The show-replace toggle is now the first item, placed before the Find field
    const showReplaceBtn = screen.getByRole("button", { name: "Show replace" });
    const findInput = screen.getByRole("textbox", { name: "Find" }) as HTMLElement;
    const findInputWrapper = findInput.closest("div")!;
    const findRow = findInputWrapper.parentElement!;
    const children = Array.from(findRow.children);
    const showReplaceIdx = children.indexOf(showReplaceBtn);
    const findInputIdx = children.indexOf(findInputWrapper);
    // Toggle comes first and sits before the find field.
    expect(showReplaceIdx).toBe(0);
    expect(showReplaceIdx).toBeLessThan(findInputIdx);

    slot.lifecycle.unmount();
  });
});