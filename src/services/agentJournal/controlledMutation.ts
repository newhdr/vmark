/**
 * Controlled mutation — the editor side of the journal's protocol for an
 * MCP write: prepare (durable, takes the document's reservation), then
 * re-verify the editor, apply, and commit.
 *
 * Pipeline: prepare → verify() → apply() → commit. A prepare refusal
 * applies nothing. A verify failure, or an editor that refuses the apply,
 * appends `aborted` and applies nothing. A commit that fails after the
 * apply is `applied` with `durable: false` — the content changed, so it is
 * never reported as an error. A queued commit lands later (basis: its
 * revision); a refused one ends `uncommitted` (basis: the pre-write head).
 *
 * An apply that THROWS may have changed the document part-way, so it is
 * never aborted on trust: `recover()` reads the document back. Unchanged
 * (the preimage) → `aborted`, carrying the error in `thrown`. Changed → the text
 * it holds is committed as the postimage and the outcome is
 * `appliedWithError`. Unreadable → `recoveryRequired`: neither committed nor
 * aborted, the transaction keeps the document's reservation and the journal
 * reports it uncommitted on its next start, so the preimage stays restorable.
 * A verify that throws ran before anything was applied: aborted, `thrown`.
 * Either way the abort reports the basis like any other, so the caller keeps
 * a baseline the prepare recorded before it rethrows the error.
 *
 * Key decisions:
 *   - `verify` and `apply` are synchronous and run back to back with no
 *     `await` between them, so nothing the user does can land in between.
 *   - A failed or rejected abort still ends as `aborted`: the request is
 *     refused either way, and the journal keeps the reservation until its
 *     drainer lands the queued record.
 *   - A prepare refused for its baseline map (`field: provenance`, recorded
 *     nothing) is resent once without it: the baseline is then a
 *     `snapshotOnly` barrier, which never certifies more than was seen.
 *   - The prepare waits for a running bind of its key
 *     (`journalDocumentReady`), so a write never lands on the fresh document
 *     a Save As or rename is about to replace; a key whose bind failed
 *     refuses the write unprepared, since the journal holds the document
 *     under another key until a bind there lands.
 *   - A commit acknowledgement that names another document or revision, or
 *     says nothing was applied, is not trusted: the write is reported not
 *     durable on the pre-write basis.
 *   - An applied write's durability is reported to the recording store
 *     under `docKey` (`recordingReport.ts`): not durable reads "history not
 *     recorded" in the panel.
 *
 * @coordinates-with services/agentJournal/journalClient.ts — the IPC calls
 * @coordinates-with services/mcpBridge/v2/documentWrite.ts — the first caller
 * @coordinates-with services/agentJournal/historyRestore.ts — a restore, through `runPreparedWrite`
 * @module services/agentJournal/controlledMutation
 */

import {
  abortControlledWrite,
  commitControlledWrite,
  prepareControlledWrite,
  type AbortReason,
  type PrepareInput,
  type PreparedTxn,
} from "./journalClient";
import { journalDocumentReady } from "./documentBinding";
import { toJournalRefusal, type JournalRefusal } from "./journalRefusal";
import { journalWarn } from "@/utils/debug";
import { beginWriteReport } from "./recordingReport";

export interface ControlledWrite<T> {
  prepare: PrepareInput;
  /** After the prepare ack: why the write must not go ahead, or `null`. */
  verify: () => AbortReason | null;
  /** Apply now; the text the document then holds, or why the editor refused. */
  apply: () => { postimage: string; value: T } | { refused: AbortReason };
  /** After an apply that threw: settle the document and return its text; throw when it cannot be read. */
  recover: () => string;
}

export type ControlledOutcome<T> =
  | { status: "refused"; refusal: JournalRefusal }
  /**
   * `basis` is the revision the tab's buffer now derives from: the baseline
   * the prepare recorded for its unjournaled text, else the parent it
   * stated. The caller keeps it as the tab's next parent. `thrown`: the
   * verify or apply threw (the document unchanged); the caller rethrows
   * `thrown.error` once it has kept the basis.
   */
  | { status: "aborted"; reason: AbortReason; durable: boolean; basis: string | null; thrown?: { error: unknown } }
  /**
   * `basis`: the committed revision; or, when the journal refused the
   * commit (the transaction then ends `uncommitted` and the head does not
   * move), the same pre-write basis an aborted write reports.
   */
  | { status: "applied"; value: T; revision: string; durable: boolean; basis: string | null }
  /**
   * The apply threw after changing the document: `postimage`, the text read
   * back, was committed in its place. `durable` and `basis` as for `applied`;
   * there is no `value`, since the apply never produced one.
   */
  | { status: "appliedWithError"; error: unknown; postimage: string; revision: string; durable: boolean; basis: string | null }
  /**
   * The apply threw and the document could not be read back: transaction
   * `txn` is left open (neither committed nor aborted), holding the
   * document's reservation for the journal's recovery. The tab's basis is
   * unknown.
   */
  | { status: "recoveryRequired"; error: unknown; txn: string };

async function abort(txn: string, reason: AbortReason): Promise<boolean> {
  try {
    return (await abortControlledWrite(txn, reason)).durable;
  } catch {
    return false;
  }
}

/**
 * Prepare; a refused baseline map is dropped and the prepare resent once.
 * Shared by every controlled prepare that carries `baselineProvenance`.
 */
export async function prepareWithBaselineRetry<I extends { baselineProvenance: unknown }, P>(
  input: I,
  send: (input: I) => Promise<P>,
): Promise<P> {
  try {
    return await send(input);
  } catch (error) {
    const refusal = toJournalRefusal(error);
    if (refusal.field !== "provenance" || input.baselineProvenance === null) throw refusal;
    journalWarn("baseline provenance refused; recording the baseline snapshot-only:", refusal.message);
    return send({ ...input, baselineProvenance: null });
  }
}

/** A controlled write whose prepare is the caller's (a restore, …). */
export interface PreparedWrite<T, P extends PreparedTxn> {
  /** The parent the prepare states; the basis when it records no baseline. */
  parent: string | null;
  /** The text the prepare records as overwritten: what `recover` reads when nothing changed. */
  preimage: string;
  /** The document's journal key, so an applied write's durability is reported. */
  docKey?: string;
  prepare: () => Promise<P>;
  verify: (prepared: P) => AbortReason | null;
  apply: (prepared: P) => { postimage: string; value: T } | { refused: AbortReason };
  /** After an apply that threw: settle the document and return its text; throw when it cannot be read. */
  recover: (prepared: P) => string;
}

/** Run one controlled write through the journal. */
export function runControlledWrite<T>(write: ControlledWrite<T>): Promise<ControlledOutcome<T>> {
  return runPreparedWrite({
    parent: write.prepare.parent,
    preimage: write.prepare.preimage,
    docKey: write.prepare.docKey,
    prepare: () => prepareWithBaselineRetry(write.prepare, prepareControlledWrite),
    verify: write.verify,
    apply: write.apply,
    recover: write.recover,
  });
}

/** Commit `postimage`: whether it landed durably, and the tab's basis afterwards. */
async function commit(
  prepared: PreparedTxn,
  postimage: string,
  basis: string | null,
  report: (durable: boolean) => void,
): Promise<{ durable: boolean; basis: string | null }> {
  try {
    const ack = await commitControlledWrite(prepared.txn, postimage);
    const landed = ack.applied && ack.doc === prepared.doc && ack.revision === prepared.revision;
    if (!landed) journalWarn("commit acknowledged another write; treating it as not durable:", ack);
    const durable = landed && ack.durable;
    report(durable);
    return { durable, basis: landed ? prepared.revision : basis };
  } catch {
    report(false);
    return { durable: false, basis };
  }
}

/** Append `aborted` and answer it on the prepare's basis; `thrown` when the verify or apply threw. */
type Aborted<T> = (reason: AbortReason, thrown?: { error: unknown }) => Promise<ControlledOutcome<T>>;

/** Run a controlled write with the caller's prepare: verify → apply → commit, or abort. */
export async function runPreparedWrite<T, P extends PreparedTxn>(
  write: PreparedWrite<T, P>,
): Promise<ControlledOutcome<T>> {
  const report = beginWriteReport(write.docKey);
  let prepared: P;
  try {
    if (write.docKey !== undefined) {
      const ready = await journalDocumentReady(write.docKey);
      if (!ready.ok) throw ready.refusal;
    }
    prepared = await write.prepare();
  } catch (error) {
    return { status: "refused", refusal: toJournalRefusal(error) };
  }
  const basis = prepared.baseline ?? write.parent;
  const aborted: Aborted<T> = async (reason, thrown) => ({
    status: "aborted",
    reason,
    durable: await abort(prepared.txn, reason),
    basis,
    ...(thrown && { thrown }),
  });
  let reason: AbortReason | null;
  try {
    reason = write.verify(prepared);
  } catch (error) {
    return aborted("applyRefused", { error });
  }
  if (reason !== null) return aborted(reason);
  let applied: ReturnType<PreparedWrite<T, P>["apply"]>;
  try {
    applied = write.apply(prepared);
  } catch (error) {
    return recoverFromThrownApply(write, prepared, { basis, report, aborted }, error);
  }
  if ("refused" in applied) return aborted(applied.refused);
  const landed = await commit(prepared, applied.postimage, basis, report);
  return { status: "applied", value: applied.value, revision: prepared.revision, ...landed };
}

/** An apply threw: abort only once the document reads back unchanged (see the header). */
async function recoverFromThrownApply<T, P extends PreparedTxn>(
  write: PreparedWrite<T, P>,
  prepared: P,
  { basis, report, aborted }: { basis: string | null; report: (durable: boolean) => void; aborted: Aborted<T> },
  error: unknown,
): Promise<ControlledOutcome<T>> {
  let postimage: string;
  try {
    postimage = write.recover(prepared);
  } catch (readError) {
    journalWarn("an apply failed and the document could not be read back; its transaction stays open:", error, readError);
    report(false);
    return { status: "recoveryRequired", error, txn: prepared.txn };
  }
  if (postimage === write.preimage) return aborted("applyRefused", { error });
  journalWarn("an apply failed part-way; committing the text the document now holds:", error);
  const landed = await commit(prepared, postimage, basis, report);
  return { status: "appliedWithError", error, postimage, revision: prepared.revision, ...landed };
}
