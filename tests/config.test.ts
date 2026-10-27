import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  normalizeConfigs,
  parseSecrets,
  sshConnectConfig,
  validateConfigs,
} from "../lib/config";

describe("validateConfigs", () => {
  it("accepts free-form names and rejects duplicates", () => {
    const good = [
      { name: "My Prod Server", host: "example.com", user: "deploy", root: "/srv/app" },
      { name: "prod2", host: "10.0.0.5" },
    ];
    expect(validateConfigs(good)).toEqual(good);
    const duplicate = [
      { name: "prod", host: "a" },
      { name: "prod", host: "b" },
    ];
    expect(() => validateConfigs(duplicate)).toThrow(/Duplicate config name "prod"/);
  });

  it("rejects empty/control-character names and host with a username", () => {
    expect(() => validateConfigs([{ name: "", host: "x" }])).toThrow(/configs\[0\]\.name.*required/);
    expect(() => validateConfigs([{ name: "a\u0000b", host: "x" }])).toThrow(/control characters/);
    expect(() => validateConfigs([{ name: "prod", host: "" }])).toThrow(/configs\[0\]\.host.*required/);
    expect(() => validateConfigs([{ name: "prod", host: "user@example.com" }])).toThrow(
      /User field, not in Host/,
    );
    expect(() => validateConfigs([{ name: "prod", host: "host with space" }])).toThrow(/spaces/);
  });

  it("rejects unknown fields with a located message", () => {
    expect(() => validateConfigs([{ name: "prod", host: "x", hop: "a" }])).toThrow(
      /Unrecognized key: "hop"/,
    );
  });

  it("rejects non-array input", () => {
    expect(() => validateConfigs({ name: "x" })).toThrow(/configs/);
  });
});

describe("parseSecrets", () => {
  it("parses the secret JSON map and rejects junk", () => {
    expect(parseSecrets(undefined)).toEqual({});
    expect(parseSecrets("")).toEqual({});
    expect(parseSecrets('{"prod":{"password":"s3cret"}}')).toEqual({
      prod: { password: "s3cret" },
    });
    expect(() => parseSecrets("not json")).toThrow(/JSON object/);
    expect(() => parseSecrets('{"prod":{"sudo":true}}')).toThrow(/Invalid secrets/);
  });
});

describe("sshConnectConfig", () => {
  it("builds auth options from the user field and host", () => {
    const config = { name: "dev", host: "10.0.0.5", user: "root", port: 2222, root: "/" };
    const options = sshConnectConfig(config, {});
    expect(options.host).toBe("10.0.0.5");
    expect(options.port).toBe(2222);
    expect(options.username).toBe("root");
  });

  it("requires a user", () => {
    expect(() => sshConnectConfig({ name: "dev", host: "10.0.0.5" }, {})).toThrow(/No SSH user/);
  });

  it("loads an existing key file, applies passphrase, and skips the agent", () => {
    const dir = mkdtempSync(join(tmpdir(), "sshfs-key-"));
    const keyPath = join(dir, "id_ed25519");
    writeFileSync(keyPath, "fake-key-material");
    try {
      const options = sshConnectConfig(
        { name: "dev", host: "10.0.0.5", user: "ops", keyPath },
        { dev: { passphrase: "pp" } },
      );
      expect(options.privateKey).toEqual(Buffer.from("fake-key-material"));
      expect(options.passphrase).toBe("pp");
      expect(options.agent).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to the ssh agent only without explicit credentials", () => {
    const withAgent = sshConnectConfig({ name: "dev", host: "10.0.0.5", user: "ops" }, {});
    expect(withAgent.agent).toBe(process.env.SSH_AUTH_SOCK);
    const withPassword = sshConnectConfig(
      { name: "dev", host: "10.0.0.5", user: "ops" },
      { dev: { password: "pw" } },
    );
    expect(withPassword.password).toBe("pw");
    expect(withPassword.agent).toBeUndefined();
  });

  it("fails for a missing key file", () => {
    expect(() =>
      sshConnectConfig(
        { name: "dev", host: "10.0.0.5", user: "ops", keyPath: "/nonexistent/key" },
        {},
      ),
    ).toThrow(/Private key not found/);
  });
});

describe("normalizeConfigs", () => {
  it("fills defaults and strips blank fields", () => {
    const configs = normalizeConfigs([
      { name: "dev", host: "root", root: "/srv", user: "  ", keyPath: "" },
    ]);
    expect(configs[0]).toMatchObject({ user: undefined, root: "/srv", keyPath: undefined });
  });
});