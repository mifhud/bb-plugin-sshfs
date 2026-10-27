// @vitest-environment jsdom
// Frontend behavior: the SSH FS page lists configs and connects, and the
// remote file editor loads, edits, and saves over RPC.
import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { rpcContract } from "../contract";
import { RemoteFileEditor } from "../components/file-editor";

const app = await loadPluginApp(() => import("../app"));

// Handlers the tested surface never calls; renderSlot's rpc map is complete,
// so stubs keep the typed map satisfied and fail loudly if actually reached.
const neverCalled = (): never => {
  throw new Error("unexpected rpc call");
};

const PROD_VIEW = {
  name: "prod",
  host: "deploy@example.com",
  root: "/srv/app",
  connected: false,
};

describe("SSH FS page", () => {
  it("lists mounted configs and connects", async () => {
    const connectCalls: string[] = [];
    const slot = renderSlot<{ subPath: string }, typeof rpcContract>(
      app.navPanels[0]!,
      { subPath: "" },
      {
        experimental_rpcContract: rpcContract,
        rpc: {
          configs_list: () => ({ configs: [PROD_VIEW] }),
          configs_save: neverCalled,
          mounts_connect: ({ name }: { name: string }) => {
            connectCalls.push(name);
            return { connected: true, root: "/srv/app", user: "deploy", host: "example.com", port: 22 };
          },
          mounts_disconnect: neverCalled,
          fs_list: neverCalled,
          fs_read: neverCalled,
          fs_write: neverCalled,
          fs_mkdir: neverCalled,
          fs_delete: neverCalled,
          fs_rename: neverCalled,
        },
      },
    );

    await slot.findByText("prod");
    await slot.findByText(/deploy@example\.com/);

    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(connectCalls).toEqual(["prod"]));
    slot.lifecycle.unmount();
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
          mounts_connect: neverCalled,
          mounts_disconnect: neverCalled,
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
          mounts_connect: neverCalled,
          mounts_disconnect: neverCalled,
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
          mounts_connect: neverCalled,
          mounts_disconnect: neverCalled,
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