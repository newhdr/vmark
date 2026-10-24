/**
 * Journal client — the IPC calls of the controlled-mutation protocol
 * (`agent_journal_prepare`, `_commit`, `_abort`) and of save capture
 * (`agent_journal_capture`), with replies validated and every rejection
 * read as a `JournalRefusal`.
 *
 * Key decisions:
 *   - Payloads cross as ONE JSON string. `JSON.stringify` escapes a lone
 *     surrogate (`\ud800`) instead of replacing it, so Rust's well-formed
 *     text check sees it and refuses `INVALID_TEXT`; a typed argument would
 *     be re-encoded on the way and could hide it.
 *   - Generations are canonical decimal strings: a JavaScript number loses
 *     precision above 2^53. A reply that is not the expected shape is
 *     refused as `JOURNAL_UNAVAILABLE`, never trusted.
 *
 * @coordinates-with src-tauri/src/agent_journal/commands.rs — the commands
 * @module services/agentJournal/journalClient
 */

import type { JournalMcpActor } from "./journalActor";
import type { JournalProvenancePayload } from "./unsavedProvenance";
import { callJournal as call, isNullableString, isObject, isString, malformed, parsePreparedTxn } from "./journalIpc";

/** Why re-verification refused to apply. */
export type AbortReason = "edited" | "closed" | "composing" | "selection" | "applyRefused";

/**
 * Why a transaction is aborted; the closed set Rust accepts. `timedOut`: its
 * prepare answered after the coordinator had given up on it, so the editor
 * never refused anything.
 */
export type JournalAbortReason = AbortReason | "timedOut";

export interface PrepareInput {
  /** `path:<file>` or `tab:<window>/<tab>` (see `documentIdentity.ts`). */
  docKey: string;
  /** The revision this tab last learned from the journal, or `null`. */
  parent: string | null;
  /** The tab's buffer as the write found it. */
  preimage: string;
  actor: JournalMcpActor;
  tool: string;
  /**
   * The certified map from the journal's head text to `preimage`, flushed
   * from the tab's unsaved edits (`unsavedProvenance.ts`). `null`: the
   * baseline is recorded as a `snapshotOnly` barrier.
   */
  baselineProvenance: JournalProvenancePayload | null;
  /**
   * A person changed the buffer since its journaled text, even if it is
   * equal again: an equal-text baseline is then still recorded.
   */
  baselineTouched: boolean;
}

import type { PreparedTxn } from "./journalIpc";
export type { PreparedTxn };

/**
 * Extra fields a commit carries beside its `postimage`, computed between the
 * apply and the commit (`journaledMutation.ts` effects). Opaque here: the
 * journal validates them (it refuses an unknown field).
 */
export type CommitExtras = Readonly<Record<string, unknown>>;

export interface CommittedTxn {
  doc: string;
  revision: string;
  applied: boolean;
  durable: boolean;
}

/** What a saved buffer was built on: a revision, or the tab's own pending save. */
export type JournalObservedRef =
  | { ref: "revision"; revision: string }
  | { ref: "pending"; observation: string };

/** Who asked for a save; not who wrote its text (`CaptureInput.author`). */
export type JournalSaveInitiator = { type: "human" } | { type: "system"; reason: string } | JournalMcpActor;

export interface CaptureInput {
  /** `path:<file>` (see `documentIdentity.ts`). */
  docKey: string;
  /** The tab's base-root name, `<window>/<tab>`. */
  window: string;
  /** `null`: the journal's head (genesis for a new document). */
  observedParent: JournalObservedRef | null;
  /** The saved editor text. */
  postimage: string;
  initiator: JournalSaveInitiator;
  /** Who wrote the saved text; `null`: the human. */
  author: JournalMcpActor | null;
  /**
   * The revision the window says holds exactly this text. The writer elides
   * the save only when that revision is still the settled head and its text
   * matches; equal text alone is recorded.
   */
  claimsRevision: string | null;
  /**
   * The window's certified map from `observedParent` (or the head) to
   * `postimage`, under its armed epoch. `null`: a `snapshotOnly` barrier.
   */
  provenance: JournalProvenancePayload | null;
}

const JOURNALED = ["yes", "pending", "no"] as const;
/** How far a save got into the journal. */
export type Journaled = (typeof JOURNALED)[number];
const isJournaled = (v: unknown): v is Journaled => JOURNALED.some((j) => j === v);

export interface CapturedSave {
  doc: string;
  journaled: Journaled;
  /** `null` when the head already held the text. */
  observation: string | null;
  /** The revision holding the saved text; set exactly when `yes`. */
  revision: string | null;
}

/** Prepare a controlled write. Rejects with a `JournalRefusal`. */
export async function prepareControlledWrite(input: PrepareInput): Promise<PreparedTxn> {
  const command = "agent_journal_prepare";
  return parsePreparedTxn(command, await call(command, { payload: JSON.stringify(input) }));
}

/**
 * Commit an open transaction with the applied text and any `extras` (which
 * never replace the postimage). Rejects with a `JournalRefusal`.
 */
export async function commitControlledWrite(txn: string, postimage: string, extras?: CommitExtras): Promise<CommittedTxn> {
  const r = await call("agent_journal_commit", { txn, payload: JSON.stringify({ ...extras, postimage }) });
  if (
    !isObject(r) ||
    !isString(r.doc) ||
    !isString(r.revision) ||
    typeof r.applied !== "boolean" ||
    typeof r.durable !== "boolean"
  ) {
    throw malformed("agent_journal_commit");
  }
  return { doc: r.doc, revision: r.revision, applied: r.applied, durable: r.durable };
}

/** Abort an open transaction. `durable: false` = queued, the document stays reserved. */
export async function abortControlledWrite(txn: string, reason: JournalAbortReason): Promise<{ durable: boolean }> {
  const r = await call("agent_journal_abort", { txn, reason });
  if (!isObject(r) || typeof r.durable !== "boolean") throw malformed("agent_journal_abort");
  return { durable: r.durable };
}

/** Record a finished save. Rejects with a `JournalRefusal`. */
export async function captureSaveToJournal(input: CaptureInput): Promise<CapturedSave> {
  const r = await call("agent_journal_capture", { payload: JSON.stringify(input) });
  if (
    !isObject(r) ||
    !isString(r.doc) ||
    !isJournaled(r.journaled) ||
    !isNullableString(r.observation) ||
    !isNullableString(r.revision) ||
    (r.journaled === "yes") !== (r.revision !== null) ||
    (r.journaled !== "yes" && r.observation === null)
  ) {
    throw malformed("agent_journal_capture");
  }
  return { doc: r.doc, journaled: r.journaled, observation: r.observation, revision: r.revision };
}
