/**
 * Text changes — the change-list shape a review diff produces, the primitives
 * that build and repair it, and the assertion that a list is canonical.
 *
 * A change is `{ fromA, toA, fromB, toB }` in UTF-16 code units: `a` in
 * `[fromA, toA)` becomes `b` in `[fromB, toB)`, and text outside every change
 * is identical in both. A CANONICAL list is sorted, every change edits
 * something, no two changes touch (a gap of at least one unit separates
 * them), no boundary falls inside a surrogate pair on either side, and
 * applying the list to `a` reproduces `b` exactly.
 *
 * Key decisions:
 *   - Text that is not well-formed UTF-16 is refused with `InvalidTextError`
 *     (`INVALID_TEXT`), the journal's code for the same refusal: a lone
 *     surrogate has no UTF-8 form, so Rust could never agree on its ranges.
 *   - Repair widens a boundary by one unit. For well-formed text one unit is
 *     always enough: a boundary is mid-pair exactly when the shared unit
 *     before it is a high surrogate (or the shared unit after it is a low
 *     one), and that holds on both sides at once.
 *
 * @module services/agentJournal/review/textChanges
 */

import { isWellFormedText } from "../wellFormedText";

export interface TextChange {
  readonly fromA: number;
  readonly toA: number;
  readonly fromB: number;
  readonly toB: number;
}

/** A diff input holds a lone surrogate. */
export class InvalidTextError extends Error {
  readonly code = "INVALID_TEXT";
  constructor(side: string) {
    super(`INVALID_TEXT: the ${side} text is not well-formed UTF-16 (lone surrogate)`);
    this.name = "InvalidTextError";
  }
}

/** Throw `InvalidTextError` unless both texts are well-formed. */
export function assertWellFormed(a: string, b: string): void {
  if (!isWellFormedText(a)) throw new InvalidTextError("base");
  if (!isWellFormedText(b)) throw new InvalidTextError("target");
}

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/** Whether offset `p` of `x` falls between the two halves of a surrogate pair. */
export const midPair = (x: string, p: number): boolean =>
  p > 0 && p < x.length && isHigh(x.charCodeAt(p - 1)) && isLow(x.charCodeAt(p));

/** Apply `changes` to `a`, taking inserted text from `b`. */
export function applyChanges(a: string, b: string, changes: readonly TextChange[]): string {
  const parts: string[] = [];
  let pos = 0;
  for (const c of changes) {
    parts.push(a.slice(pos, c.fromA), b.slice(c.fromB, c.toB));
    pos = c.toA;
  }
  parts.push(a.slice(pos));
  return parts.join("");
}

/** The single change left after trimming the common prefix and suffix, unrepaired. O(n). */
export function trimmedChanges(a: string, b: string): TextChange[] {
  if (a === b) return [];
  const max = Math.min(a.length, b.length);
  let p = 0;
  while (p < max && a.charCodeAt(p) === b.charCodeAt(p)) p++;
  let s = 0;
  while (s < max - p && a.charCodeAt(a.length - 1 - s) === b.charCodeAt(b.length - 1 - s)) s++;
  return [{ fromA: p, toA: a.length - s, fromB: p, toB: b.length - s }];
}

/**
 * Widen every change so no boundary splits a surrogate pair, then merge
 * changes that overlap or touch. Input: sorted, consistent changes over
 * well-formed texts.
 */
export function repairAndMerge(a: string, changes: readonly TextChange[]): TextChange[] {
  const out: { fromA: number; toA: number; fromB: number; toB: number }[] = [];
  for (const c0 of changes) {
    const c = { ...c0 };
    if (c.fromA > 0 && isHigh(a.charCodeAt(c.fromA - 1))) {
      c.fromA--;
      c.fromB--;
    }
    if (c.toA < a.length && isLow(a.charCodeAt(c.toA))) {
      c.toA++;
      c.toB++;
    }
    const last = out.at(-1);
    if (last && last.toA >= c.fromA) {
      last.toA = Math.max(last.toA, c.toA);
      last.toB = Math.max(last.toB, c.toB);
    } else out.push(c);
  }
  return out;
}

function fail(why: string, c?: TextChange): never {
  throw new Error(`diff not canonical: ${why}${c ? ` ${JSON.stringify(c)}` : ""}`);
}

/** Fail loud unless `changes` is a canonical change list from `a` to `b`. */
export function assertCanonical(a: string, b: string, changes: readonly TextChange[]): void {
  let prevA = 0;
  let prevB = 0;
  changes.forEach((c, i) => {
    const units = [c.fromA, c.toA, c.fromB, c.toB];
    if (!units.every((n) => Number.isSafeInteger(n) && n >= 0)) fail("offsets must be non-negative integers", c);
    if (c.toA < c.fromA || c.toB < c.fromB || c.toA > a.length || c.toB > b.length) fail("malformed change", c);
    if (i > 0 && c.fromA <= prevA) fail("changes overlap, touch or are out of order", c);
    if (c.fromA - prevA !== c.fromB - prevB) fail("unchanged gap differs between sides", c);
    if (c.fromA === c.toA && c.fromB === c.toB) fail("empty change", c);
    if (midPair(a, c.fromA) || midPair(a, c.toA) || midPair(b, c.fromB) || midPair(b, c.toB)) {
      fail("boundary inside a surrogate pair", c);
    }
    prevA = c.toA;
    prevB = c.toB;
  });
  if (a.length - prevA !== b.length - prevB || applyChanges(a, b, changes) !== b) {
    fail("changes do not reconstruct the target");
  }
}
