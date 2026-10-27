import { describe, expect, it } from "vitest";
import {
  isBinaryBuffer,
  kindFromMode,
  normalizeRoot,
  resolveRemote,
  sortEntries,
} from "../lib/paths";

describe("normalizeRoot", () => {
  it("defaults to / and collapses slashes", () => {
    expect(normalizeRoot(undefined)).toBe("/");
    expect(normalizeRoot("")).toBe("/");
    expect(normalizeRoot("/srv/app/")).toBe("/srv/app");
    expect(normalizeRoot("srv/app")).toBe("/srv/app");
    expect(normalizeRoot("/a//b/")).toBe("/a/b");
  });

  it("keeps ~ and ~/… roots for remote home expansion", () => {
    expect(normalizeRoot("~")).toBe("~");
    expect(normalizeRoot("~/code/")).toBe("~/code");
  });
});

describe("resolveRemote", () => {
  it("joins relative paths onto the root", () => {
    expect(resolveRemote("/srv/app", "src/main.ts")).toBe("/srv/app/src/main.ts");
    expect(resolveRemote("/", "etc/hosts")).toBe("/etc/hosts");
    expect(resolveRemote("/srv/app", ".")).toBe("/srv/app");
    expect(resolveRemote("~", "code/x")).toBe("~/code/x");
  });

  it("refuses escaping and hostile paths", () => {
    expect(() => resolveRemote("/srv/app", "../etc/passwd")).toThrow(/root/);
    expect(() => resolveRemote("/srv/app", "a/../../b")).toThrow(/root/);
    expect(() => resolveRemote("/srv/app", "/etc/passwd")).toThrow(/relative/);
    expect(() => resolveRemote("/srv/app", "")).toThrow(/empty/);
    expect(() => resolveRemote("/srv/app", "a\\b")).toThrow(/forward/);
    expect(() => resolveRemote("/srv/app", "a\x00b")).toThrow(/NUL/);
  });
});

describe("kindFromMode", () => {
  it("maps POSIX file type bits", () => {
    expect(kindFromMode(0o040755)).toBe("dir");
    expect(kindFromMode(0o100644)).toBe("file");
    expect(kindFromMode(0o120777)).toBe("link");
    expect(kindFromMode(0o020000)).toBe("other");
    expect(kindFromMode(null)).toBe("file");
    expect(kindFromMode(0)).toBe("file");
  });
});

describe("sortEntries", () => {
  it("puts directories first, then case-insensitive names", () => {
    const entries = [
      { kind: "file", name: "zeta.txt" },
      { kind: "dir", name: "Assets" },
      { kind: "dir", name: "assets" },
      { kind: "file", name: "Alpha.txt" },
    ];
    expect(sortEntries(entries).map((entry) => entry.name)).toEqual([
      "Assets",
      "assets",
      "Alpha.txt",
      "zeta.txt",
    ]);
  });
});

describe("isBinaryBuffer", () => {
  it("detects NUL bytes and invalid UTF-8", () => {
    expect(isBinaryBuffer(Buffer.from([0x00, 0x01, 0x02]))).toBe(true);
    expect(isBinaryBuffer(Buffer.from([0xff, 0xfe, 0x00]))).toBe(true);
    expect(isBinaryBuffer(Buffer.from("héllo wörld\n"))).toBe(false);
  });
});