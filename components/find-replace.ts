// Find & replace engine for the remote file editor, modelled on the Monaco
// find widget. All functions are pure and operate on the raw draft text so
// they are unit-testable without a DOM.
//
// Search semantics mirror Monaco: patterns run per line (so `^`/`$` anchor at
// line boundaries and matches never span lines), `\b` whole-word wrapping,
// optional case sensitivity, and `$&`/`$1`/`$$` replacement expansion in
// regex mode (plain-text mode treats the replacement literally).

export interface FindOptions {
  matchCase: boolean;
  wholeWord: boolean;
  regex: boolean;
}

export function findMatches(
  text: string,
  query: string,
  options: FindOptions,
): { matches: Array<readonly [number, number]>; valid: boolean } {
  const matches: Array<readonly [number, number]> = [];
  const { valid } = walk(text, query, options, (start, end) => {
    matches.push([start, end]);
  });
  return { matches, valid };
}

/**
 * Walk every match of `query` in `text` in document order, calling `visit`
 * with the absolute start/end offsets. Returns whether the query compiled; on
 * an invalid regex the walker runs nothing.
 */
export function visitMatches(
  text: string,
  query: string,
  options: FindOptions,
  visit: (start: number, end: number) => void,
): { valid: boolean } {
  return walk(text, query, options, visit);
}

/**
 * Replace every match. Captures capture groups so `$1` backreferences work;
 * plain-text mode expands `$` tokens literally (Monaco leaves them alone
 * outside regex mode — `$$` still yields `$` since that is the escape that
 * survives both modes).
 */
export function replaceAllInText(
  text: string,
  query: string,
  options: FindOptions,
  replacement: string,
  preserveCase: boolean,
): { text: string; count: number; valid: boolean } {
  if (query === "") return { text, count: 0, valid: true };
  let re: RegExp;
  try {
    re = new RegExp(buildPattern(query, options), `g${options.matchCase ? "" : "i"}u`);
  } catch {
    return { text, count: 0, valid: false };
  }
  let count = 0;
  const out: string[] = [];
  for (const line of text.split("\n")) {
    re.lastIndex = 0;
    let chunk = "";
    let last = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(line)) !== null) {
      const matchText = match[0];
      let next = expandReplacement(
        replacement,
        line,
        match.index,
        matchText,
        match.slice(1),
        options.regex,
      );
      if (preserveCase) next = preserveCaseReplacement(matchText, next);
      chunk += line.slice(last, match.index) + next;
      last = match.index + matchText.length;
      count += 1;
      if (matchText.length === 0) re.lastIndex = match.index + 1;
    }
    chunk += line.slice(last);
    out.push(chunk);
  }
  return { text: out.join("\n"), count, valid: true };
}

/** Replace just the `[start, end)` range (used by the single Replace button). */
export function replaceRangeInText(
  text: string,
  query: string,
  options: FindOptions,
  replacement: string,
  preserveCase: boolean,
  start: number,
  end: number,
): { text: string; valid: boolean; matchText: string; next: string } {
  let captured: string[] = [];
  const { valid } = walk(
    text,
    query,
    options,
    (matchStart, matchEnd, groups) => {
      if (matchStart === start && matchEnd === end) captured = groups;
    },
  );
  const matchText = text.slice(start, end);
  let next = expandReplacement(replacement, text, start, matchText, captured, options.regex);
  if (preserveCase) next = preserveCaseReplacement(matchText, next);
  return { text: text.slice(0, start) + next + text.slice(end), valid, matchText, next };
}

export function buildPattern(query: string, options: FindOptions): string {
  let pattern = options.regex ? query : escapeRegExp(query);
  if (options.wholeWord) pattern = `\\b(?:${pattern})\\b`;
  return pattern;
}

function walk(
  text: string,
  query: string,
  options: FindOptions,
  visit: (start: number, end: number, groups: string[]) => void,
): { valid: boolean } {
  if (query === "") return { valid: true };
  let re: RegExp;
  try {
    re = new RegExp(buildPattern(query, options), `g${options.matchCase ? "" : "i"}u`);
  } catch {
    return { valid: false };
  }
  let lineStart = 0;
  for (const line of text.split("\n")) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(line)) !== null) {
      visit(lineStart + match.index, lineStart + match.index + match[0].length, match.slice(1));
      if (match[0].length === 0) {
        // Empty match (e.g. `\b` or `a*`): advance by one code unit so the
        // walker terminates instead of matching the same spot forever.
        re.lastIndex = match.index + 1;
      }
    }
    lineStart += line.length + 1;
  }
  return { valid: true };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `$$`/`$&` always expand (Monaco behavior); `$``, `$'` and `$1`-`$99`
 * only in regex mode — plain-text replacements keep those tokens literal. */
export function expandReplacement(
  replacement: string,
  source: string,
  matchStart: number,
  matchText: string,
  groups: string[],
  regexMode: boolean,
): string {
  return replacement.replace(
    /\$(?:(\$)|(&)|(`)|(')|(\d{1,2}))/g,
    (token, isDollar, isAll, isPrefix, isSuffix, group) => {
      if (isDollar !== undefined) return "$";
      if (isAll !== undefined) return matchText;
      if (!regexMode) return token;
      if (isPrefix !== undefined) return source.slice(0, matchStart);
      if (isSuffix !== undefined) return source.slice(matchStart + matchText.length);
      const index = Number(group) - 1;
      return index >= 0 && index < groups.length ? (groups[index] ?? "") : "";
    },
  );
}

/** Monaco's preserve-case rules: all-caps → caps, capitalized → capitalize. */
export function preserveCaseReplacement(matchText: string, replacement: string): string {
  if (matchText.length === 0 || replacement.length === 0) return replacement;
  if (matchText === matchText.toUpperCase() && /[A-Z]/.test(matchText)) {
    return replacement.toUpperCase();
  }
  const first = matchText[0];
  if (first === first.toUpperCase() && /[A-Z]/.test(first)) {
    return replacement[0].toUpperCase() + replacement.slice(1);
  }
  return replacement[0].toLowerCase() + replacement.slice(1);
}