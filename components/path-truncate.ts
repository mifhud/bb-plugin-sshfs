// Front-truncation helper for the editor toolbar path.
//
// CSS `direction: rtl` + `text-overflow: ellipsis` cuts from the wrong end in
// several browsers; instead we measure candidate strings with a hidden span and
// binary-search the longest suffix — prepended with `…` — that fits.

/** Front-truncate `text` so its rendered width fits within `availableWidth`
 *  (in pixels). The **end** of the string — typically the filename — stays
 *  visible, preceded by `…`. If the full text already fits, it is returned
 *  unchanged.
 *
 *  `measure` reports the rendered pixel width of a candidate string (e.g. by
 *  setting `textContent` on a hidden span with the same font and reading
 *  `scrollWidth`). */
export function frontTruncate(
  text: string,
  availableWidth: number,
  measure: (candidate: string) => number,
): string {
  if (measure(text) <= availableWidth + 0.5) return text;

  // Binary search for the longest suffix (1..text.length chars) whose
  // `…`-prefixed form fits. lo = 0 means "nothing but the ellipsis".
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const candidate = "…" + text.slice(text.length - mid);
    if (measure(candidate) <= availableWidth) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }

  return "…" + text.slice(text.length - lo);
}
