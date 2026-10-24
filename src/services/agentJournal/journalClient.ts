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
 *   - A prepare and a commit answer whether a selection certificate was
 *     used; a fallback to the whole-document barrier is logged here, once
 *     for every caller, and the journal counts it in its status.
 *   - Each call of `prepareControlledWrite` is one logical request: it mints
 *     one `requestId` and freezes the payload once (`freezePreparePayload`).
 *     The journal answers an identical retry from its receipt, so a prepare
 *     reply is decoded losslessly, every field in wire order.
 *
 * @coordinates-with src-tauri/src/agent_journal/commands.rs — the commands
 * @module services/agentJournal/journalClient
 */

import type { JournalMcpActor } from "./journalActor";
import type { JournalProvenancePayload } from "./unsavedProvenance";
import type { SelectionCertificate } from "./selectionCertificate";
import type { CaptureId } from "./provenance/captureId";
import {
  callJournal as call,
  freezePreparePayload,
  isNullableString,
  isObject,
  isString,
  malformed,
  mintRequestId,
  parsePreparedTxn,
} from "./journalIpc";
import { journalWarn } from "@/utils/debug";

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
  /**
   * A Source `selection.set`'s exact change (`selectionCertificate.ts`).
   * Omitted otherwise: the commit is then a whole-document barrier.
   */
  certificate?: SelectionCertificate | null;
  /** The provenance freeze this buffer was taken under; omitted when nothing froze it. */
  capture?: CaptureId;
}

import type { PreparedTxn } from "./journalIpc";
export type { PreparedTxn };

/** A controlled prepare's reply, every field the journal sent. */
export interface ControlledPrepared extends PreparedTxn {
  /** The prepare persisted the certificate it was sent. */
  certified: boolean;
  /** Why a sent certificate was not used; `null` when certified or none was sent. */
  fallbackReason: FallbackReason | null;
}

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
  /** The provenance freeze this save was taken under; omitted for an unbound save. */
  capture?: CaptureId;
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

/** Why the journal did not use a certificate (`FallbackReason` in Rust). */
const FALLBACK_REASONS = ["notTheParent", "notThePostimage", "wholeBreak", "splitsACharacter", "noFreeSlots", "overCap"] as const;
type FallbackReason = (typeof FALLBACK_REASONS)[number];
const isFallbackReason = (v: unknown): v is FallbackReason => FALLBACK_REASONS.some((f) => f === v);

/**
 * Check a reply's `certified` and `fallbackReason` (a certified reply has no
 * reason) and log a fallback: the write was recorded as a barrier.
 */
function checkCertification(command: string, r: Record<string, unknown>, doc: string): void {
  const reason = r.fallbackReason;
  const known = reason === null || isFallbackReason(reason);
  if (typeof r.certified !== "boolean" || !known || (r.certified && reason !== null)) throw malformed(command);
  if (reason !== null) journalWarn(`${command}: the certificate for ${doc} was not used (${String(reason)}); recorded as a barrier`);
}

/** Read `command`'s reply as a controlled prepare, losslessly. Throws `malformed`. */
export function parseControlledPrepared(command: string, r: unknown): ControlledPrepared {
  const { doc, txn, revision, generation, baseline } = parsePreparedTxn(command, r);
  const reply = r as Record<string, unknown>;
  checkCertification(command, reply, doc);
  const fallbackReason = isFallbackReason(reply.fallbackReason) ? reply.fallbackReason : null;
  return { doc, txn, revision, generation, baseline, certified: reply.certified === true, fallbackReason };
}

/** Prepare a controlled write, as one new logical request. Rejects with a `JournalRefusal`. */
export async function prepareControlledWrite(input: PrepareInput): Promise<ControlledPrepared> {
  const command = "agent_journal_prepare";
  const payload = freezePreparePayload(input, mintRequestId());
  return parseControlledPrepared(command, await call(command, { payload }));
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
  checkCertification("agent_journal_commit", r, r.doc);
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
