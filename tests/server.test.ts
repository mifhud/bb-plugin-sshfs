// Factory-level tests: settings/RPC wiring and CLI surfaces through the
// official fake plugin host. Live SSH/SFTP behavior lives in sftp.test.ts
// and is exercised end-to-end by the smoke script.
import { describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  type FakePluginHarness,
} from "@get-bb/plugin-sdk/testing";
import plugin, { rpcContract } from "../server";
import type { ConfigView } from "../contract";

// The fake host validates every call against the registered contract schemas
// at the boundary, so the result is the method's declared output shape.
async function callRpc<T>(
  harness: FakePluginHarness,
  method: string,
  input: unknown,
): Promise<T> {
  return (await harness.behavior.callRpc(method, input)) as T;
}

type ConfigsResult = { configs: ConfigView[] };

function makeConfig(overrides: Record<string, unknown> = {}) {
  return { name: "prod", host: "example.com", user: "deploy", root: "/srv/app", ...overrides };
}

async function setup(settings: Record<string, string | number | boolean> = {}) {
  const fake = createFakePluginHost({
    pluginId: "sshfs",
    settings: { configs: "[]", idleTimeoutSeconds: 60, ...settings },
  });
  await plugin(fake.bb);
  return fake;
}

describe("RPC", () => {
  it("lists no configs by default and persists saved ones", async () => {
    const { harness } = await setup();
    const empty = await callRpc<ConfigsResult>(harness, "configs_list", null);
    expect(empty).toEqual({ configs: [] });

    const saved = await callRpc<ConfigsResult>(harness, "configs_save", {
      configs: [makeConfig()],
    });
    expect(saved.configs).toEqual([{ ...makeConfig(), connected: false, hasPassword: false }]);

    const listed = await callRpc<ConfigsResult>(harness, "configs_list", null);
    expect(listed.configs).toHaveLength(1);
    expect(listed.configs[0]).toMatchObject({
      name: "prod",
      host: "example.com",
      user: "deploy",
      hasPassword: false,
    });
    expect(harness.realtimeSignals.some((signal) => signal.channel === "sshfs-changed")).toBe(true);
  });

  it("rejects duplicate names and invalid fields with clear errors", async () => {
    const { harness } = await setup();
    await expect(
      harness.behavior.callRpc("configs_save", {
        configs: [makeConfig(), makeConfig()],
      }),
    ).rejects.toThrow(/Duplicate config name "prod"/);

    await expect(
      harness.behavior.callRpc("configs_save", {
        configs: [{ name: "", host: "x" }],
      }),
    ).rejects.toThrow(/rpc input validation failed/);

    // Secrets belong in secrets_set, not in the config (strict schema).
    await expect(
      harness.behavior.callRpc("configs_save", {
        configs: [makeConfig({ password: "hunter2" })],
      }),
    ).rejects.toThrow(/rpc input validation failed/);
  });

  it("sets, keeps, and clears passwords via secrets_set", async () => {
    const { harness } = await setup({ configs: JSON.stringify([makeConfig()]) });

    const set = await callRpc<{ hasPassword: boolean }>(harness, "secrets_set", {
      name: "prod",
      password: "s3cret",
    });
    expect(set).toEqual({ hasPassword: true });
    const listed = await callRpc<ConfigsResult>(harness, "configs_list", null);
    expect(listed.configs[0]?.hasPassword).toBe(true);
    // The value itself never appears in views.
    expect(JSON.stringify(listed)).not.toContain("s3cret");

    const clear = await callRpc<{ hasPassword: boolean }>(harness, "secrets_set", {
      name: "prod",
      password: null,
    });
    expect(clear).toEqual({ hasPassword: false });

    await expect(
      harness.behavior.callRpc("secrets_set", { name: "ghost", password: "x" }),
    ).rejects.toThrow(/No SSH FS config named "ghost"/);
  });

  it("disconnects unknown mounts harmlessly and validates input", async () => {
    const { harness } = await setup();
    const result = await callRpc<{ disconnected: boolean }>(
      harness,
      "mounts_disconnect",
      { name: "ghost" },
    );
    expect(result).toEqual({ disconnected: false });
    await expect(harness.behavior.callRpc("fs_list", { mount: "ghost", path: "." })).rejects.toThrow(
      /No SSH FS config named "ghost"/,
    );
  });

  it("tests unknown mounts with a clear error", async () => {
    const { harness } = await setup();
    await expect(harness.behavior.callRpc("mounts_test", { name: "ghost" })).rejects.toThrow(
      /No SSH FS config named "ghost"/,
    );
  });

  it("refuses traversal in paths before any connection is attempted", async () => {
    const { harness } = await setup({ configs: JSON.stringify([makeConfig()]) });
    await expect(
      harness.behavior.callRpc("fs_read", { mount: "prod", path: "../etc/passwd" }),
    ).rejects.toThrow(/escapes the mount root/);
    await expect(
      harness.behavior.callRpc("fs_read", { mount: "prod", path: "/etc/passwd" }),
    ).rejects.toThrow(/relative to the mount root/);
    await expect(
      harness.behavior.callRpc("fs_rename", { mount: "prod", from: "a", to: "../../etc/passwd" }),
    ).rejects.toThrow(/escapes the mount root/);
  });

  it("declares the expected methods", () => {
    expect(Object.keys(rpcContract)).toEqual(
      expect.arrayContaining([
        "configs_list",
        "configs_save",
        "secrets_set",
        "mounts_connect",
        "mounts_disconnect",
        "mounts_test",
        "fs_list",
        "fs_read",
        "fs_write",
        "fs_mkdir",
        "fs_delete",
        "fs_rename",
      ]),
    );
  });
});

describe("CLI", () => {
  it("lists configs (with connection state) and prints a hint when empty", async () => {
    const { harness } = await setup();
    const empty = await harness.behavior.runCli(["list"]);
    expect(empty.exitCode).toBe(0);
    expect(empty.stdout).toContain("No SSH FS configs");

    const withConfig = await setup({ configs: JSON.stringify([makeConfig()]) });
    const listed = await withConfig.harness.behavior.runCli(["list"]);
    expect(listed.exitCode).toBe(0);
    expect(listed.stdout).toMatch(/disconnected\s+prod\s+example\.com/);
    const json = await withConfig.harness.behavior.runCli(["list", "--json"]);
    expect(JSON.parse(json.stdout)).toEqual([
      { ...makeConfig(), connected: false, hasPassword: false },
    ]);
  });

  it("fails clearly for unknown configs", async () => {
    const { harness } = await setup();
    for (const args of [
      ["connect", "nope"],
      ["ls", "nope"],
      ["cat", "nope", "x"],
      ["write", "nope", "x", "--content", "hi"],
      ["mkdir", "nope", "x"],
      ["rm", "nope", "x"],
      ["mv", "nope", "a", "b"],
    ]) {
      const result = await harness.behavior.runCli(args);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('No SSH FS config named "nope"');
    }
    const bad = await harness.behavior.runCli(["frobnicate"]);
    expect(bad.exitCode).toBe(1);
  });

  it("disconnect on a never-connected mount reports that harmlessly", async () => {
    const { harness } = await setup();
    const result = await harness.behavior.runCli(["disconnect", "nope"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("was not connected");
  });
});