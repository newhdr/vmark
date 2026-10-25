/**
 * Journaled mutation — the one coordinator for changing a tab's buffer as a
 * controlled mutation of the agent edit journal. Its callers (an MCP edit,
 * `mcpBridge/v2/journaledEdit.ts`; a history restore, `historyRestore.ts`)
 * differ only in their adapters: prepare, verify, apply, recover, effects
 * and the outcome mapper.
 *
 * Pipeline: refuse an evicted basis → freeze the tab's unsaved provenance at
 * the preimage (and await its payload, then the caller's `recheck`) → state
 * the expected head and name the payload's predecessor (`expectedHead.ts`)
 * → the caller's prepare → verify → apply, forking the provenance window onto the
 * applied text → effects → commit (`controlledMutation.ts`) → settle the
 * tab's journal basis → settle the freeze and the forks → map the outcome.
 *
 * Key decisions:
 *   - A basis evicted from the bounded identity table refuses STALE_PARENT
 *     before anything is sent: the retry rebases on the journal's head
 *     instead of writing without a compare-and-set.
 *   - Every prepare states the head it expects: the tab's basis, else the
 *     head read as the prepare is built, inside its send turn and after the
 *     document is ready, so a save answered before it is already the head.
 *     A head read that is refused or outlives its deadline refuses with
 *     nothing sent. A payload is sent only with the
 *     predecessor it names (`observedParent`); one the tab cannot name is
 *     dropped, so the baseline is a `snapshotOnly` barrier.
 *   - Basis: a STALE_PARENT refusal, an unreadable apply
 *     (`recoveryRequired`) or a commit refused with no basis drops it;
 *     otherwise the outcome's basis is kept. A tab closed since `life` was
 *     taken (perhaps reopened under the same id) learns nothing.
 *   - Provenance: the apply forks the window in the same synchronous step,
 *     so the mutation's own change is never certified as a person's. Forks
 *     are recorded at the committed revision; an abort records the freeze at
 *     the baseline its prepare recorded; a refusal releases the freeze only
 *     when its disposition says so (the journal proved nothing was
 *     admitted, or nothing was sent: `journalRequest.ts`); anything left
 *     unsettled is invalidated.
 *   - An apply that throws is read back through `recover`, never assumed
 *     undone: a changed buffer bumps the tab's MCP revision (the store may
 *     have thrown before its own bump), forks like an applied text, and is
 *     committed (`appliedWithError`); an unchanged one aborts, keeps the
 *     basis, then rethrows the error; an unreadable one stays open
 *     (`recoveryRequired`).
 *   - A commit that fails is still applied, `durable: false`, on the
 *     pre-mutation basis; the journal's degraded queue then refuses the next
 *     mutation until it drains. It is not read back: the applied text is
 *     known.
 *   - The effects hook (optional; absent by default) runs after a successful
 *     apply and before the commit, and what it returns rides on the commit.
 *     It fails LOUD: a hook that throws, or has not settled within
 *     `EFFECTS_DEADLINE_MS`, never skips the commit. The applied text is
 *     committed without extras (the journal records its conservative
 *     barrier) and the outcome is the degraded `appliedWithError`, carrying
 *     the hook's error. It never runs after an abort or a thrown apply.
 *   - The outcome mapper runs before the freeze and forks are invalidated,
 *     as each caller's answer did.
 *   - Every await is bounded, so the answer fits the MCP bridge's total
 *     (`journalDeadline.ts`): the pre-apply budget starts before the freeze
 *     payload, and a payload or prepare attempt that outlives it refuses
 *     `JOURNAL_TIMEOUT` with nothing applied; then the effects deadline and
 *     one bounded commit (`controlledMutation.ts`).
 *
 * @coordinates-with services/agentJournal/controlledMutation.ts — the protocol
 * @coordinates-with services/agentJournal/unsavedProvenance.ts — the freeze and fork
 * @coordinates-with services/agentJournal/documentIdentity.ts — the basis
 * @coordinates-with services/agentJournal/expectedHead.ts — the parent and observedParent
 * @module services/agentJournal/journaledMutation
 */

import { useRevisionStore } from "@/stores/documentStore";
import type { AbortReason, CommitExtras, JournalBaseRef, PreparedTxn, PrepareSpec } from "./journalClient";
import { expectedHead, observedParentFor } from "./expectedHead";
import { runPreparedWrite } from "./controlledMutation";
import { JournalRefusal } from "./journalRefusal";
import { JOURNAL_PREAPPLY_BUDGET_MS, journalTimeout, settleWithin, startJournalBudget } from "./journalDeadline";
import { forkUnsavedProvenance, freezeUnsavedProvenance, type JournalProvenancePayload } from "./unsavedProvenance";
import type { ProvenanceFork } from "./provenance/session";
import type { CaptureId } from "./provenance/captureId";
import { forgetJournalBasis, isJournalBasisEvicted, isJournalTabLive, outstandingSaveBase, rememberJournalBasis } from "./documentIdentity";

/** How long the effects hook may take before the commit goes ahead without it. */
export const EFFECTS_DEADLINE_MS = 5000;

/** What the coordinator hands the caller's prepare: the shared baseline fields. */
interface MutationBaseline {
  docKey: string;
  /** The head the tab expects (its basis, else the head it read); `null` is genesis. */
  parent: string | null;
  preimage: string;
  baselineProvenance: JournalProvenancePayload | null;
  /** The predecessor `baselineProvenance` was built on; absent with no payload. */
  observedParent?: JournalBaseRef;
  baselineTouched: boolean;
  /** The freeze's capture id; absent when the tab has no provenance source. */
  capture?: CaptureId;
}

/** The settled result the outcome mapper turns into the caller's answer. */
export type JournaledOutcome<T> =
  | { status: "refused"; refusal: JournalRefusal }
  | { status: "aborted"; reason: AbortReason }
  | { status: "applied"; value: T; durable: boolean }
  /** The apply threw after changing the buffer, or the effects hook failed; the applied text was committed. */
  | { status: "appliedWithError"; error: unknown; durable: boolean }
  /** The apply threw and the tab could not be read back; the journal keeps the transaction open. */
  | { status: "recoveryRequired"; error: unknown };

export interface JournaledMutation<T, P extends PreparedTxn, O> {
  tabId: string;
  /** The tab's journal lifecycle token, taken before the caller's first await. */
  life: number;
  /** The journal key the mutation is prepared and committed under. */
  docKey: string;
  /** The buffer as the mutation found it. */
  preimage: string;
  /** Ends the evicted-basis refusal's message (`retry`, `re-read and retry`). */
  retryHint: string;
  /** After the provenance payload was awaited: why the tab must not be prepared now, or `null`. */
  recheck?: () => AbortReason | null;
  /** The prepare request (`controlledPrepare`, `restorePrepare`); the coordinator sends it. */
  prepare: (baseline: MutationBaseline) => Promise<PrepareSpec<P>> | PrepareSpec<P>;
  /** After the prepare ack, synchronously: why the mutation must not go ahead, or `null`. */
  verify: (prepared: P) => AbortReason | null;
  /** Apply now, synchronously; `postimage` is the text the store then holds. */
  apply: (prepared: P) => { postimage: string; value: T } | { refused: AbortReason };
  /** After an apply that threw: bring the store into agreement and return the tab's text; throw when it cannot be read. */
  recover: () => string;
  /** After a successful apply, before the commit: extra fields for the commit (see the header). */
  effects?: (preimage: string, postimage: string) => Promise<CommitExtras>;
  outcome: (outcome: JournaledOutcome<T>) => O | Promise<O>;
}

/** `run()`, or a rejection once `EFFECTS_DEADLINE_MS` passes without it settling. */
function withinEffectsDeadline(run: () => Promise<CommitExtras>): Promise<CommitExtras> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`the commit effects did not settle within ${EFFECTS_DEADLINE_MS} ms`)), EFFECTS_DEADLINE_MS);
  });
  const running = new Promise<CommitExtras>((settle) => settle(run()));
  return Promise.race([running, expired]).finally(() => clearTimeout(timer));
}

/** Run one journaled mutation of `m.tabId`; the outcome mapper's answer. Rethrows an apply that threw with nothing changed. */
export async function runJournaledMutation<T, P extends PreparedTxn, O>(m: JournaledMutation<T, P, O>): Promise<O> {
  const { tabId, docKey, preimage } = m;
  const budget = startJournalBudget();
  if (isJournalBasisEvicted(tabId, docKey)) {
    forgetJournalBasis(tabId, docKey);
    const evicted = new JournalRefusal("STALE_PARENT", `the tab's journal basis was evicted; ${m.retryHint}`);
    return m.outcome({ status: "refused", refusal: evicted });
  }
  const inFlightSave = outstandingSaveBase(tabId, docKey);
  const freeze = freezeUnsavedProvenance(tabId, preimage);
  const forks: ProvenanceFork[] = [];
  const fork = (postimage: string): void => {
    const f = forkUnsavedProvenance(tabId, postimage);
    if (f) forks.push(f);
  };
  /** Record what the journal answered, unless the tab closed since. */
  const settleBasis = (basis: string | null): void => {
    if (!isJournalTabLive(tabId, m.life)) return;
    if (basis === null) forgetJournalBasis(tabId, docKey);
    else rememberJournalBasis(tabId, docKey, basis);
  };
  const { effects } = m;
  // The freeze's settlement this coordinator chose; the `finally` invalidates only an unsettled one.
  let freezeSettled = false;
  const releaseFreeze = (): void => {
    freezeSettled = true;
    freeze?.release();
  };
  try {
    const frozen = freeze ? await settleWithin(freeze.payload(null), budget.remaining()) : { value: null };
    if (frozen === null) {
      // Nothing was sent: a client-side refusal releases.
      releaseFreeze();
      return await m.outcome({ status: "refused", refusal: journalTimeout("the provenance freeze", JOURNAL_PREAPPLY_BUDGET_MS) });
    }
    const named = frozen.value;
    // The payload awaited: the tab may have changed under it.
    const changed = freeze ? (m.recheck?.() ?? null) : null;
    if (changed) return await m.outcome({ status: "aborted", reason: changed });
    // Stated once the prepare is built (see the header).
    let parent: string | null = null;
    const prepare = async (): Promise<PrepareSpec<P>> => {
      const expected = await expectedHead(tabId, docKey, budget, inFlightSave);
      if ("refusal" in expected) throw expected.refusal;
      parent = expected.parent;
      const observedParent = named ? observedParentFor(tabId, docKey, parent, named.basis) : null;
      return m.prepare({
        docKey,
        parent,
        preimage,
        baselineProvenance: observedParent && named ? named.payload : null,
        ...(observedParent && { observedParent }),
        baselineTouched: freeze?.touched ?? false,
        ...(freeze && { capture: freeze.capture }),
      });
    };
    const outcome = await runPreparedWrite({
      parent: () => parent,
      preimage,
      docKey,
      prepare,
      ...(freeze && { turn: (send) => freeze.inTurn(send) }),
      verify: m.verify,
      apply: (prepared) => {
        const applied = m.apply(prepared);
        if ("postimage" in applied) fork(applied.postimage);
        return applied;
      },
      recover: () => {
        const postimage = m.recover();
        if (postimage !== preimage) {
          // The store may have thrown before its own revision bump: a client
          // holding the old revision token must not overwrite the mutation.
          useRevisionStore.getState().updateRevision(tabId);
          fork(postimage);
        }
        return postimage;
      },
      budget,
      ...(effects && { effects: (postimage: string) => withinEffectsDeadline(() => effects(preimage, postimage)) }),
    });

    if (outcome.status === "refused") {
      if (outcome.disposition === "release") releaseFreeze();
      if (outcome.refusal.journalCode === "STALE_PARENT") settleBasis(null);
      return await m.outcome({ status: "refused", refusal: outcome.refusal });
    }
    if (outcome.status === "recoveryRequired") {
      settleBasis(null);
      return await m.outcome({ status: "recoveryRequired", error: outcome.error });
    }
    settleBasis(outcome.basis);
    if (outcome.status === "aborted") {
      if (outcome.basis !== null) {
        freezeSettled = true;
        freeze?.recorded(outcome.basis);
      }
      if (outcome.thrown) throw outcome.thrown.error;
      return await m.outcome({ status: "aborted", reason: outcome.reason });
    }
    if (outcome.basis === outcome.revision) for (const f of forks) f.recorded(outcome.revision);
    if (outcome.status === "appliedWithError") {
      return await m.outcome({ status: "appliedWithError", error: outcome.error, durable: outcome.durable });
    }
    return await m.outcome({ status: "applied", value: outcome.value, durable: outcome.durable });
  } finally {
    // The first settlement wins, so this only reaches what nothing recorded.
    for (const f of forks) f.invalidate();
    if (!freezeSettled) freeze?.invalidate();
  }
}
