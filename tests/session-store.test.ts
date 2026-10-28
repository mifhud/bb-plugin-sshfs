// Session store expiry: stale disconnected sessions forget their directory.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  expireStaleSessions,
  getMountCwd,
  getMountSession,
  markMountConnected,
  markMountDisconnected,
  resetSessionStore,
  setMountCwd,
} from "../components/session-store";

beforeEach(() => {
  resetSessionStore();
  vi.restoreAllMocks();
});

describe("expireStaleSessions", () => {
  it("drops the remembered directory once the window elapses", () => {
    const now = 1_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now - 700_000);
    markMountConnected("prod");
    setMountCwd("prod", "apps");
    vi.spyOn(Date, "now").mockReturnValue(now);

    expireStaleSessions([{ name: "prod", connected: false }], 600, now);

    expect(getMountSession("prod")).toBeUndefined();
    expect(getMountCwd("prod")).toBe("");
  });

  it("keeps fresh sessions, live mounts, and manual disconnects", () => {
    const now = 2_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now - 10_000);
    markMountConnected("fresh");
    setMountCwd("fresh", "apps");
    markMountConnected("live");
    setMountCwd("live", "src");
    setMountCwd("manual", "docs");
    markMountDisconnected("manual");

    expireStaleSessions(
      [
        { name: "fresh", connected: false },
        { name: "live", connected: true },
        { name: "manual", connected: false },
      ],
      600,
      now,
    );

    expect(getMountCwd("fresh")).toBe("apps");
    expect(getMountCwd("live")).toBe("src");
    expect(getMountCwd("manual")).toBe("docs");
  });

  it("drops every disconnected session when remembering is off", () => {
    markMountConnected("prod");
    setMountCwd("prod", "apps");

    expireStaleSessions([{ name: "prod", connected: false }], 0);

    expect(getMountSession("prod")).toBeUndefined();
  });
});
