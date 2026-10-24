/**
 * Journaled mutation — the one coordinator for changing a tab's buffer as a
 * controlled mutation of the agent edit journal. Its callers (an MCP edit,
 * `mcpBridge/v2/journaledEdit.ts`; a history restore, `historyRestore.ts`)
 * differ only in their adapters: prepare, verify, apply, recover, effects
 * and the outcome mapper.
 *
 * Pipeline: refuse an evicted basis → freeze the tab's unsaved provenance at
 * the preimage (and await its payload, then the caller's `recheck`) → the
 * caller's prepare → verify → apply, forking the provenance window onto the
 * applied text → effects → commit (`controlledMutation.ts`) → settle the
 * tab's journal basis → settle the freeze and the forks → map the outcome.
 *
 * Key decisions:
 *   - A basis evicted from the bounded identity table refuses STALE_PARENT
 *     before anything is sent: the retry rebases on the journal's head
 *     instead of writing without a compare-and-set.
 *   - Basis: a STALE_PARENT refusal, an unreadable apply
 *     (`recoveryRequired`) or a commit refused with no basis drops it;
 *     otherwise the outcome's basis is kept. A tab closed since `life` was
 *     taken (perhaps reopened under the same id) learns nothing.
 *   - Provenance: the apply forks the window in the same synchronous step,
 *     so the mutation's own change is never certified as a person's. Forks
 *     are recorded at the committed revision; an abort records the freeze at
 *     the baseline its prepare recorded; anything left unsettled is
 *     invalidated (the first settlement wins).
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
 *
 * @coordinates-with services/agentJournal/controlledMutation.ts — the protocol
 * @coordinates-with services/agentJournal/unsavedProvenance.ts — the freeze and fork
 * @coordinates-with services/agentJournal/documentIdentity.ts — the basis
 * @module services/agentJournal/journaledMutation
 */

import { useRevisionStore } from "@/stores/documentStore";
import type { AbortReason, CommitExtras, PreparedTxn } from "./journalClient";
import { runPreparedWrite } from "./controlledMutation";
import { JournalRefusal } from "./journalRefusal";
import { forkUnsavedProvenance, freezeUnsavedProvenance, type JournalProvenancePayload } from "./unsavedProvenance";
import type { ProvenanceFork } from "./provenance/session";
import {
  forgetJournalBasis,
  isJournalBasisEvicted,
  isJournalTabLive,
  journalBasis,
  rememberJournalBasis,
} from "./documentIdentity";

/** How long the effects hook may take before the commit goes ahead without it. */
export const EFFECTS_DEADLINE_MS = 5000;

/** What the coordinator hands the caller's prepare: the shared baseline fields. */
interface MutationBaseline {
  docKey: string;
  /** The tab's journal basis for `docKey`, or `null`. */
  parent: string | null;
  preimage: string;
  baselineProvenance: JournalProvenancePayload | null;
  baselineTouched: boolean;
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
  prepare: (baseline: MutationBaseline) => Promise<P>;
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
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`the commit effects did not settle within ${EFFECTS_DEADLINE_MS} ms`)),
      EFFECTS_DEADLINE_MS,
    );
    new Promise<CommitExtras>((settle) => settle(run())).then(
      (extras) => {
        clearTimeout(timer);
        resolve(extras);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Run one journaled mutation of `m.tabId`; the outcome mapper's answer. Rethrows an apply that threw with nothing changed. */
export async function runJournaledMutation<T, P extends PreparedTxn, O>(m: JournaledMutation<T, P, O>): Promise<O> {
  const { tabId, docKey, preimage } = m;
  if (isJournalBasisEvicted(tabId, docKey)) {
    forgetJournalBasis(tabId, docKey);
    const evicted = new JournalRefusal("STALE_PARENT", `the tab's journal basis was evicted; ${m.retryHint}`);
    return m.outcome({ status: "refused", refusal: evicted });
  }
  const parent = journalBasis(tabId, docKey);
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
  try {
    const named = freeze ? await freeze.payload(parent) : null;
    // The payload awaited: the tab may have changed under it.
    const changed = freeze ? (m.recheck?.() ?? null) : null;
    if (changed) return await m.outcome({ status: "aborted", reason: changed });
    const baseline: MutationBaseline = {
      docKey,
      parent,
      preimage,
      baselineProvenance: named?.payload ?? null,
      baselineTouched: freeze?.touched ?? false,
    };
    const outcome = await runPreparedWrite({
      parent,
      preimage,
      docKey,
      prepare: () => m.prepare(baseline),
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
      ...(effects && { effects: (postimage: string) => withinEffectsDeadline(() => effects(preimage, postimage)) }),
    });

    if (outcome.status === "refused") {
      if (outcome.refusal.journalCode === "STALE_PARENT") settleBasis(null);
      return await m.outcome({ status: "refused", refusal: outcome.refusal });
    }
    if (outcome.status === "recoveryRequired") {
      settleBasis(null);
      return await m.outcome({ status: "recoveryRequired", error: outcome.error });
    }
    settleBasis(outcome.basis);
    if (outcome.status === "aborted") {
      if (outcome.basis !== null) freeze?.recorded(outcome.basis);
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
    freeze?.invalidate();
  }
}
