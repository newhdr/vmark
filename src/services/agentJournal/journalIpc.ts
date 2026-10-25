/**
 * Journal IPC — the shared call and reply-shape helpers of the agent edit
 * journal's clients: every rejection is read as a `JournalRefusal`, a reply
 * that is not the expected shape is refused as `JOURNAL_UNAVAILABLE`, and a
 * prepare's payload is frozen once under its request id and page pair.
 *
 * Key decisions:
 *   - A bound reply (`{bind, reply}`) is checked against what was sent
 *     before its reply is read: a bind that differs in any field, or has a
 *     field too many, is malformed, never a confirmation of this request.
 *   - A prepare's or abandon's refusal is validated here, at the boundary,
 *     into `JournalRefusal.settlement` (`journalSettlement.ts`).
 *
 * @coordinates-with services/agentJournal/journalClient.ts — the controlled-write calls
 * @coordinates-with services/agentJournal/historyClient.ts — the history panel's calls
 * @module services/agentJournal/journalIpc
 */

import { invokeJournal } from "./journalTransport";
import { JournalRefusal, toJournalRefusal } from "./journalRefusal";
import { settleRequestRefusal, type RequestExpectation } from "./journalSettlement";
import { isDecimalU64 } from "./provenance/payload";

export const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
export const isString = (v: unknown): v is string => typeof v === "string" && v.length > 0;
export const isNullableString = (v: unknown): v is string | null => v === null || isString(v);
/** A canonical decimal `u64` (generations, epochs, sequence numbers); see `isDecimalU64`. */
export const isDecimal = isDecimalU64;

/** The latest instant a JavaScript `Date` holds, in milliseconds. */
const DATE_MAX_MS = 8.64e15;

/** A wire timestamp: whole milliseconds since the epoch that a `Date` can format. */
export const isEpochMillis = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= DATE_MAX_MS;

export function malformed(command: string): JournalRefusal {
  return new JournalRefusal("JOURNAL_UNAVAILABLE", `${command} returned a malformed reply`);
}

/**
 * Read `command`'s reply as an open transaction: the shape every prepare
 * (a controlled write's, a restore's) answers with. Throws `malformed`.
 */
export interface PreparedTxn {
  doc: string;
  txn: string;
  /** The revision id the commit will carry. */
  revision: string;
  /** Journal generation, decimal string. */
  generation: string;
  /** The human revision recorded for unjournaled buffer text, if any. */
  baseline: string | null;
}

export function parsePreparedTxn(command: string, r: unknown): PreparedTxn {
  if (
    !isObject(r) ||
    !isString(r.doc) ||
    !isString(r.txn) ||
    !isString(r.revision) ||
    !isDecimal(r.generation) ||
    !isNullableString(r.baseline)
  ) {
    throw malformed(command);
  }
  return { doc: r.doc, txn: r.txn, revision: r.revision, generation: r.generation, baseline: r.baseline };
}

/** A fresh request id for one logical prepare: a UUID v4, lowercase, 36 ASCII bytes. */
export function mintRequestId(): string {
  return crypto.randomUUID();
}

/** The registered page a request is sent for: the writer's incarnation and the page pair. */
export interface PageIdentityFields {
  incarnation: string;
  /** Decimal string, opaque: never read as a number. */
  webviewGeneration: string;
  /** 32 lowercase hex. */
  pageIdentity: string;
}

/**
 * A prepare's payload `P`, serialized once: its fields, then `requestId`
 * and the page identity. The journal digests these exact bytes, so a retry
 * of the same logical request, and its abandon, resend this string
 * unchanged, never re-serialize the fields.
 */
export function freezePreparePayload(fields: object, requestId: string, page: PageIdentityFields): string {
  const { incarnation, webviewGeneration, pageIdentity } = page;
  return JSON.stringify({ ...fields, requestId, incarnation, webviewGeneration, pageIdentity });
}

/** Lowercase hex SHA-256 of `text`'s UTF-8 bytes: the digest the journal computes of `P`. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The `reply` of a bound answer whose `bind` is exactly `bind`, every
 * field equal and none extra. Throws `malformed` otherwise.
 */
export function parseBound(command: string, r: unknown, bind: Readonly<Record<string, string>>): unknown {
  if (!isObject(r) || !isObject(r.bind) || !("reply" in r)) throw malformed(command);
  const got = r.bind;
  const keys = Object.keys(bind);
  const same = Object.keys(got).length === keys.length && keys.every((k) => got[k] === bind[k]);
  if (!same) throw malformed(command);
  return r.reply;
}

/**
 * Invoke a journal command; a rejection is rethrown as a `JournalRefusal`.
 * With `expect` (a prepare or abandon), the refusal carries its validated
 * `settlement`.
 */
export async function callJournal(command: string, args: Record<string, unknown>, expect?: RequestExpectation): Promise<unknown> {
  try {
    return await invokeJournal(command, args);
  } catch (error) {
    const refusal = toJournalRefusal(error);
    if (!expect) throw refusal;
    const { journalCode, message, head, field, uncertain, hunk, block } = refusal;
    const settlement = settleRequestRefusal(error, expect);
    throw new JournalRefusal(journalCode, message, head, field, { uncertain, hunk, block, settlement });
  }
}
