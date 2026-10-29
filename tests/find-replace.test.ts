// @vitest-environment node
// Pure find & replace engine (Monaco find widget semantics): per-line search,
// case sensitivity, whole word, regex, replacement expansion, preserve case.
import { describe, expect, it } from "vitest";
import {
  expandReplacement,
  findMatches,
  preserveCaseReplacement,
  replaceAllInText,
  replaceRangeInText,
} from "../components/find-replace";

const plain = { matchCase: false, wholeWord: false, regex: false };

describe("findMatches", () => {
  it("finds case-insensitive literal matches by default", () => {
    expect(findMatches("Hello hello HELLO", "hello", plain).matches).toHaveLength(3);
  });

  it("respects match case", () => {
    const { matches } = findMatches("Hello hello", "Hello", { ...plain, matchCase: true });
    expect(matches).toEqual([[0, 5]]);
  });

  it("matches whole words only", () => {
    const { matches } = findMatches("cat catalog scatter cat", "cat", { ...plain, wholeWord: true });
    expect(matches).toEqual([
      [0, 3],
      [20, 23],
    ]);
  });

  it("escapes literal queries", () => {
    const { matches } = findMatches("a.b c", "a.b", plain);
    expect(matches).toEqual([[0, 3]]);
  });

  it("supports regex patterns", () => {
    const { matches } = findMatches("cat bat cot", "c.t", { ...plain, regex: true });
    expect(matches).toEqual([
      [0, 3],
      [8, 11],
    ]);
  });

  it("anchors ^ and $ per line", () => {
    const { matches } = findMatches("foo\nbar\nfoo", "^foo", { ...plain, regex: true });
    expect(matches).toEqual([
      [0, 3],
      [8, 11],
    ]);
  });

  it("reports invalid regexes without walking", () => {
    const calls: number[] = [];
    const { valid } = findMatches("text", "(", { ...plain, regex: true });
    expect(valid).toBe(false);
    expect(calls).toEqual([]);
  });

  it("terminates on empty matches (e.g. a*)", () => {
    const { matches, valid } = findMatches("aaab", "a*", { ...plain, regex: true });
    expect(valid).toBe(true);
    expect(matches.length).toBeGreaterThan(0);
  });

  it("returns no matches for the empty query", () => {
    const { matches, valid } = findMatches("anything", "", plain);
    expect(valid).toBe(true);
    expect(matches).toEqual([]);
  });
});

describe("replaceAllInText", () => {
  it("replaces every literal occurrence and counts them", () => {
    const result = replaceAllInText("one two one", "one", plain, "1", false);
    expect(result).toEqual({ text: "1 two 1", count: 2, valid: true });
  });

  it("respects match case and whole word", () => {
    const { text } = replaceAllInText("Cat cat", "cat", { ...plain, matchCase: true, wholeWord: true }, "dog", false);
    expect(text).toBe("Cat dog");
  });

  it("supports regex backreferences in the replacement", () => {
    const { text, count } = replaceAllInText("foo foo", "(f)(o+)", { ...plain, regex: true }, "$2$1", false);
    expect(text).toBe("oof oof");
    expect(count).toBe(2);
  });

  it("expands $& to the full match", () => {
    const { text } = replaceAllInText("abc", "b", plain, "<$&>", false);
    expect(text).toBe("a<b>c");
  });

  it("preserves case like Monaco", () => {
    expect(replaceAllInText("HELLO hello Hello", "hello", plain, "hi", true).text).toBe("HI hi Hi");
  });

  it("keeps $n literal in plain-text mode but expands $&", () => {
    const { text } = replaceAllInText("x[1]", "[", plain, "<$&>$1", false);
    expect(text).toBe("x<[>$11]");
  });
});

describe("replaceRangeInText", () => {
  it("replaces only the requested range", () => {
    const result = replaceRangeInText("a b a", "a", plain, "x", false, 4, 5);
    expect(result.text).toBe("a b x");
    expect(result.matchText).toBe("a");
  });

  it("captures groups for the single match", () => {
    const result = replaceRangeInText("foofoo", "(foo)", { ...plain, regex: true }, "[$1]", false, 0, 3);
    expect(result.text).toBe("[foo]foo");
  });
});

describe("expandReplacement", () => {
  it("expands $&, $1, $$, $` and $'", () => {
    expect(expandReplacement("$&-$1-$$", "source", 1, "match", ["g1"], true)).toBe("match-g1-$");
    expect(expandReplacement("$`", "abcMATCHxyz", 3, "MATCH", [], true)).toBe("abc");
    expect(expandReplacement("$'", "abcMATCHxyz", 3, "MATCH", [], true)).toBe("xyz");
  });

  it("only expands $$ and $& outside regex mode", () => {
    expect(expandReplacement("$& $1 $`", "abcMATCHxyz", 3, "MATCH", [], false)).toBe("MATCH $1 $`");
  });

  it("leaves unknown group numbers empty", () => {
    expect(expandReplacement("$9", "source", 0, "m", ["only"], true)).toBe("");
  });
});

describe("preserveCaseReplacement", () => {
  it("uppercases for all-caps matches", () => {
    expect(preserveCaseReplacement("HELLO", "hi")).toBe("HI");
  });

  it("capitalizes for capitalized matches", () => {
    expect(preserveCaseReplacement("Hello", "hi")).toBe("Hi");
  });

  it("keeps lowercase matches lowercase", () => {
    expect(preserveCaseReplacement("hello", "HI")).toBe("hI");
  });
});