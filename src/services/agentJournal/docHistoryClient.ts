/**
 * Document history client — the history panel's revision list over the
 * agent edit journal (`agent_journal_history`): a document's revisions with
 * who made each one, its live hunks whose automatic revert is blocked, and
 * whether a record of it is still queued.
 *
 * Key decisions:
 *   - Every reply is checked before it is trusted (`journalIpc.ts`): an
 *     unknown revision kind, break reason, hunk state or principal state is
 *     a malformed reply, refused as `JOURNAL_UNAVAILABLE`, never shown as
 *     some other state.
 *   - A blocked hunk's `lastCertified` stays `null` when the journal has
 *     none; the panel must not invent a location for it.
 *
 * @coordinates-with src-tauri/src/agent_journal/controller_doc_history.rs — the reply
 * @module services/agentJournal/docHistoryClient
 */

import { callJournal, isDecimal, isEpochMillis, isNullableString, isObject, isString, malformed } from "./journalIpc";
import { parseJournalActor, type JournalActor } from "./journalActor";
import { BREAK_REASONS, type BreakReason } from "./provenance/accumulator";

export const REVISION_KINDS = ["controlled", "observed", "concurrent", "gap", "tombstone"] as const;
export type RevisionKind = (typeof REVISION_KINDS)[number];

const HUNK_STATES = ["pending", "kept", "reverted", "conflicted", "superseded", "resolvedByHumanEdit", "settled"] as const;
type HunkState = (typeof HUNK_STATES)[number];

export interface HistoryRow {
  revision: string;
  /** Journal order, decimal string. */
  seq: string;
  /** Milliseconds since the epoch. */
  at: number;
  kind: RevisionKind;
  /** The linear parent; `null` is the empty document the journal starts from. */
  parent: string | null;
  actor: JournalActor;
  /** Who asked for it to be recorded, when the journal keeps that. */
  initiator: JournalActor | null;
  tool: string | null;
  restore: boolean;
  /** Its text was collected by retention; it cannot be restored. */
  collected: boolean;
}

export interface BlockedHunk {
  hunkId: string;
  state: HunkState;
  reason: BreakReason;
  origin: string;
  lastCertified: string | null;
  blockedAt: string | null;
  target: string;
}

export interface DocumentHistory {
  generation: string;
  rows: HistoryRow[];
  truncated: boolean;
  blocked: BlockedHunk[];
  /** A record of this document is queued, not yet on disk. */
  degraded: boolean;
}

const COMMAND = "agent_journal_history";

const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === "string" && (list as readonly string[]).includes(v);

function rowOf(r: unknown): HistoryRow {
  if (!isObject(r)) throw malformed(COMMAND);
  const actor = parseJournalActor(r.actor);
  const initiator = r.initiator === null ? null : parseJournalActor(r.initiator);
  if (
    !isString(r.revision) ||
    !isDecimal(r.seq) ||
    !isEpochMillis(r.at) ||
    !oneOf(REVISION_KINDS, r.kind) ||
    !isNullableString(r.parent) ||
    actor === undefined ||
    initiator === undefined ||
    !isNullableString(r.tool) ||
    typeof r.restore !== "boolean" ||
    typeof r.collected !== "boolean"
  ) {
    throw malformed(COMMAND);
  }
  return {
    revision: r.revision,
    seq: r.seq,
    at: r.at,
    kind: r.kind,
    parent: r.parent,
    actor,
    initiator,
    tool: r.tool,
    restore: r.restore,
    collected: r.collected,
  };
}

function blockedOf(b: unknown): BlockedHunk {
  if (
    !isObject(b) ||
    !isString(b.hunkId) ||
    !oneOf(HUNK_STATES, b.state) ||
    !oneOf(BREAK_REASONS, b.reason) ||
    !isString(b.origin) ||
    !isNullableString(b.lastCertified) ||
    !isNullableString(b.blockedAt) ||
    !isString(b.target)
  ) {
    throw malformed(COMMAND);
  }
  return {
    hunkId: b.hunkId,
    state: b.state,
    reason: b.reason,
    origin: b.origin,
    lastCertified: b.lastCertified,
    blockedAt: b.blockedAt,
    target: b.target,
  };
}

/** Document `docKey`'s history. Rejects with a `JournalRefusal`. */
export async function listDocumentHistory(docKey: string): Promise<DocumentHistory> {
  const r = await callJournal(COMMAND, { payload: JSON.stringify({ docKey }) });
  if (
    !isObject(r) ||
    !isDecimal(r.generation) ||
    !Array.isArray(r.rows) ||
    typeof r.truncated !== "boolean" ||
    !Array.isArray(r.blocked) ||
    typeof r.degraded !== "boolean"
  ) {
    throw malformed(COMMAND);
  }
  return {
    generation: r.generation,
    rows: r.rows.map(rowOf),
    truncated: r.truncated,
    blocked: r.blocked.map(blockedOf),
    degraded: r.degraded,
  };
}
