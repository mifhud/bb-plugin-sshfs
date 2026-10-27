import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  normalizeConfigs,
  parseSecrets,
  splitHost,
  sshConnectConfig,
  validateConfigs,
} from "../lib/config";

describe("splitHost", () => {
  it("splits user@host and keeps bare hosts", () => {
    expect(splitHost("deploy@example.com")).toEqual({ user: "deploy", host: "example.com" });
    expect(splitHost("example.com")).toEqual({ host: "example.com" });
    expect(splitHost("@example.com")).toEqual({ host: "@example.com" });
  });
});

describe("validateConfigs", () => {
  it("accepts valid configs and rejects duplicates", () => {
    const good = [{ name: "prod", host: "deploy@example.com", root: "/srv/app" }];
    expect(validateConfigs(good)).toEqual(good);
    const duplicate = [
      { name: "prod", host: "a@x" },
      { name: "prod", host: "b@y" },
    ];
    expect(() => validateConfigs(duplicate)).toThrow(/Duplicate config name "prod"/);
  });

  it("rejects bad names, hosts, and unknown fields with a located message", () => {
    expect(() => validateConfigs([{ name: "Prod", host: "x" }])).toThrow(/configs\[0\]\.name.*Name/);
    expect(() => validateConfigs([{ name: "prod", host: "" }])).toThrow(/configs\[0\]\.host.*Host/);
    expect(() => validateConfigs([{ name: "prod", host: "x", hop: "a" }])).toThrow(/Unrecognized key: "hop"/);
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
  it("builds agent-auth options from host/user/port", () => {
    const config = { name: "dev", host: "root@10.0.0.5", port: 2222, root: "/" };
    const options = sshConnectConfig(config, {});
    expect(options.host).toBe("10.0.0.5");
    expect(options.port).toBe(2222);
    expect(options.username).toBe("root");
  });

  it("requires a user and needs no keyPath when absent", () => {
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

  it("applies a password secret without a keyPath", () => {
    const options = sshConnectConfig(
      { name: "dev", host: "10.0.0.5", user: "ops" },
      { dev: { password: "pw" } },
    );
    expect(options.password).toBe("pw");
    const noPassword = sshConnectConfig({ name: "dev", host: "10.0.0.5", user: "ops" }, {});
    expect(noPassword.password).toBeUndefined();
  });
});

describe("normalizeConfigs", () => {
  it("fills defaults and strips blank fields", () => {
    const configs = normalizeConfigs([
      { name: "dev", host: "root@x", root: "/srv", user: "  ", keyPath: "" },
    ]);
    expect(configs[0]).toMatchObject({ user: undefined, root: "/srv", keyPath: undefined });
  });
});