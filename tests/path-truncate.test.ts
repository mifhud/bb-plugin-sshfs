// @vitest-environment node
// Pure logic: frontTruncate keeps the filename end visible when the path
// overflows its container, instead of CSS truncate which cuts from the end.
import { describe, expect, it } from "vitest";
import { frontTruncate } from "../components/path-truncate";

// Monospace assumption: every character is `charWidth` pixels wide.
const monospace = (charWidth: number) => (str: string) => str.length * charWidth;

const LONG = "devops@10.0.7.127:home/devops/jns_65/filevalidator/test1.txt";

describe("frontTruncate", () => {
  it("returns the full text when it already fits", () => {
    const measure = monospace(8);
    // 60 chars × 8 px = 480 px, available 500 px
    expect(frontTruncate(LONG, 500, measure)).toBe(LONG);
  });

  it("returns text that exactly fits (within half a pixel tolerance)", () => {
    const measure = monospace(8);
    // 60 × 8 = 480 px, available exactly 480
    expect(frontTruncate(LONG, 480, measure)).toBe(LONG);
  });

  it("front-truncates with `…` when the text overflows", () => {
    const measure = monospace(8);
    // 60 chars = 480 px, available 100 px
    const result = frontTruncate(LONG, 100, measure);
    const ellipsisLen = "…".length;
    expect(result.startsWith("…")).toBe(true);
    expect(result).not.toBe(LONG);
    // The suffix kept should be the longest that fits
    const kept = result.slice(ellipsisLen);
    expect(measure(result)).toBeLessThanOrEqual(100);
    // Extending by one more char would overflow
    if (kept.length < LONG.length) {
      expect(measure("…" + LONG.slice(LONG.length - kept.length - 1))).toBeGreaterThan(100);
    }
  });

  it("keeps the filename end visible (not the mount prefix)", () => {
    const measure = monospace(7);
    // Narrow enough that only the filename survives
    const result = frontTruncate(LONG, 80, measure);
    expect(result.startsWith("…")).toBe(true);
    // The filename `test1.txt` must be a suffix of the result
    expect(result.endsWith("test1.txt")).toBe(true);
    expect(result).not.toMatch(/^devops/);
  });

  it("returns just `…` when nothing but the ellipsis fits", () => {
    const measure = monospace(8);
    // Available width smaller than "…" itself won't happen in practice,
    // but the function should still produce a valid result.
    const result = frontTruncate(LONG, 3, measure);
    expect(result).toBe("…");
  });

  it("handles empty string", () => {
    const measure = monospace(8);
    expect(frontTruncate("", 100, measure)).toBe("");
  });

  it("handles single-character text that fits", () => {
    const measure = monospace(8);
    expect(frontTruncate("A", 10, measure)).toBe("A");
  });

  it("handles single-character text that does not fit", () => {
    const measure = monospace(8);
    const result = frontTruncate("A", 3, measure);
    expect(result).toBe("…");
  });

  it("finds the longest suffix that fits", () => {
    const measure = monospace(10);
    // text = 30 chars, available = 50 px → 5 chars fit after "…" (1 char)
    // 1 + 5 = 6 chars × 10 = 60 > 50, so 4 chars: 1 + 4 = 5 × 10 = 50 ≤ 50+0.5
    const text = "0123456789abcdefghijklmno1234"; // 29 chars
    const result = frontTruncate(text, 50, measure);
    expect(result.startsWith("…")).toBe(true);
    const kept = result.slice(1);
    expect(measure(result)).toBeLessThanOrEqual(50);
    // One more char would overflow
    expect(measure("…" + text.slice(text.length - kept.length - 1))).toBeGreaterThan(50);
  });

  it("uses the measure function for each candidate", () => {
    // Verify measure is actually called (not just returning the input)
    const measure = monospace(8);
    let calls = 0;
    const countingMeasure = (str: string) => {
      calls++;
      return measure(str);
    };
    frontTruncate(LONG, 100, countingMeasure);
    expect(calls).toBeGreaterThan(1);
  });
});
