/**
 * Journal IPC — the shared call and reply-shape helpers of the agent edit
 * journal's clients: every rejection is read as a `JournalRefusal`, a reply
 * that is not the expected shape is refused as `JOURNAL_UNAVAILABLE`, and a
 * prepare's payload is frozen once under its request id.
 *
 * @coordinates-with services/agentJournal/journalClient.ts — the controlled-write calls
 * @coordinates-with services/agentJournal/historyClient.ts — the history panel's calls
 * @module services/agentJournal/journalIpc
 */

import { invoke } from "@tauri-apps/api/core";
import { JournalRefusal, toJournalRefusal } from "./journalRefusal";
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

/**
 * A prepare's payload, serialized once: its fields, then `requestId`. The
 * journal digests these exact bytes, so a retry of the same logical request
 * must resend this string unchanged, never re-serialize the fields.
 */
export function freezePreparePayload(fields: object, requestId: string): string {
  return JSON.stringify({ ...fields, requestId });
}

/** Invoke a journal command; a rejection is rethrown as a `JournalRefusal`. */
export async function callJournal(command: string, args: Record<string, string>): Promise<unknown> {
  try {
    return await invoke<unknown>(command, args);
  } catch (error) {
    throw toJournalRefusal(error);
  }
}
