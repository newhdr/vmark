/**
 * History restore — put an earlier text back into a tab as a controlled
 * mutation of the agent edit journal, from the history panel: a journaled
 * revision, an uncommitted entry's preimage, or a pre-journal checkpoint.
 *
 * Pipeline: read the tab's buffer → freeze its unsaved provenance at that
 * text → journal restore prepare (records the overwritten buffer first as
 * the user's baseline; replies with the text to put back) → re-verify the
 * tab → apply the text → fork the provenance window onto it → commit →
 * settle the freeze and the fork → keep the tab's journal basis.
 *
 * Key decisions:
 *   - Re-verify is whole-buffer: a tab closed (`closed`) or edited
 *     (`edited`) while the prepare was in flight aborts, and nothing is
 *     applied. A tab that became another document meanwhile (a Save As
 *     moves its journal key) aborts as `closed`: the restore was prepared
 *     against the old document. So does a tab closed and reopened (same id,
 *     its lifecycle token changed), and a closed tab learns no basis.
 *     The apply runs right after the re-verify with no `await` between.
 *   - An equal text is still committed: the journal records the restore as
 *     a barrier either way, and the panel reports it unchanged.
 *   - Basis handling is the controlled write's: a STALE_PARENT refusal, or
 *     a commit refused with no basis, drops the basis so the next write
 *     rebases on the journal's head.
 *   - An apply that throws is read back from the store, never assumed
 *     undone: a changed buffer is committed and answered `appliedWithError`
 *     (its provenance forked like an applied one, its MCP revision bumped); a closed tab leaves the
 *     transaction open (`recoveryRequired`) and drops the basis; an
 *     unchanged buffer is an abort that keeps the recorded baseline as the
 *     basis, then rethrows the error.
 *
 * @coordinates-with services/agentJournal/controlledMutation.ts — the protocol
 * @coordinates-with services/agentJournal/historyClient.ts — the restore prepare
 * @coordinates-with services/agentJournal/unsavedProvenance.ts — the freeze and fork
 * @module services/agentJournal/historyRestore
 */

import { useDocumentStore, useRevisionStore } from "@/stores/documentStore";
import { canonicalizeLineEndings } from "@/utils/editorText";
import { getCurrentWindowLabel } from "@/services/persistence/workspaceStorage";
import type { AbortReason } from "./journalClient";
import { prepareWithBaselineRetry, runPreparedWrite } from "./controlledMutation";
import { prepareRestore, type RestoreSource } from "./historyClient";
import { JournalRefusal } from "./journalRefusal";
import { forkUnsavedProvenance, freezeUnsavedProvenance } from "./unsavedProvenance";
import type { ProvenanceFork } from "./provenance/session";
import {
  docKeyFor,
  forgetJournalBasis,
  isJournalBasisEvicted,
  isJournalTabLive,
  journalBasis,
  journalTabLife,
  rememberJournalBasis,
} from "./documentIdentity";

export type HistoryRestoreOutcome =
  | { status: "refused"; refusal: JournalRefusal }
  | { status: "aborted"; reason: AbortReason }
  /** `changed`: the buffer's text changed; `resolves`: the uncommitted entry it ended. */
  | { status: "applied"; durable: boolean; changed: boolean; resolves: string | null }
  /** The apply threw after changing the buffer; the text it holds was committed. */
  | { status: "appliedWithError"; error: unknown; durable: boolean; changed: true; resolves: string | null }
  /** The apply threw and the tab could not be read back; the journal keeps the restore open. */
  | { status: "recoveryRequired"; error: unknown };

const contentOf = (tabId: string): string | undefined => useDocumentStore.getState().documents[tabId]?.content;

/** The tab's journal key now, or `undefined` once it is closed (or closed and reopened since `life`). */
function keyOf(tabId: string, life: number): string | undefined {
  const doc = useDocumentStore.getState().documents[tabId];
  if (!doc || !isJournalTabLive(tabId, life)) return undefined;
  return docKeyFor({ tabId, filePath: doc.filePath }, getCurrentWindowLabel());
}

/** Restore `source` into the tab `tabId` through the journal. */
export async function restoreFromHistory(tabId: string, source: RestoreSource): Promise<HistoryRestoreOutcome> {
  const doc = useDocumentStore.getState().documents[tabId];
  if (!doc) return { status: "aborted", reason: "closed" };
  const preimage = doc.content;
  const docKey = docKeyFor({ tabId, filePath: doc.filePath }, getCurrentWindowLabel());
  const life = journalTabLife(tabId);
  /** Drop the basis after a refusal; a tab closed meanwhile has none to drop. */
  const forget = () => {
    if (isJournalTabLive(tabId, life)) forgetJournalBasis(tabId, docKey);
  };
  if (isJournalBasisEvicted(tabId, docKey)) {
    forgetJournalBasis(tabId, docKey);
    return { status: "refused", refusal: new JournalRefusal("STALE_PARENT", "the tab's journal basis was evicted; retry") };
  }
  const parent = journalBasis(tabId, docKey);
  const freeze = freezeUnsavedProvenance(tabId, preimage);
  const forks: ProvenanceFork[] = [];
  const fork = (postimage: string): void => {
    const f = forkUnsavedProvenance(tabId, postimage);
    if (f) forks.push(f);
  };
  let resolves: string | null = null;
  try {
    const named = freeze ? await freeze.payload(parent) : null;
    const input = {
      docKey,
      parent,
      preimage,
      source,
      baselineProvenance: named?.payload ?? null,
      baselineTouched: freeze?.touched ?? false,
    };
    const outcome = await runPreparedWrite({
      parent,
      preimage,
      docKey,
      prepare: () => prepareWithBaselineRetry(input, prepareRestore),
      verify: () => {
        const now = contentOf(tabId);
        if (now === undefined || keyOf(tabId, life) !== docKey) return "closed";
        return now === preimage ? null : "edited";
      },
      apply: (prepared) => {
        resolves = prepared.resolves;
        const text = canonicalizeLineEndings(prepared.text);
        if (text !== preimage) useDocumentStore.getState().setEditorContent(tabId, text);
        const postimage = contentOf(tabId) ?? text;
        fork(postimage);
        return { postimage, value: postimage !== preimage };
      },
      recover: () => {
        const now = contentOf(tabId);
        if (now === undefined || keyOf(tabId, life) !== docKey) throw new Error("the tab closed during the restore");
        if (now !== preimage) {
          // The store may have thrown before its own revision bump: a client
          // holding the old revision token must not overwrite the restore.
          useRevisionStore.getState().updateRevision(tabId);
          fork(now);
        }
        return now;
      },
    });
    if (outcome.status === "refused") {
      if (outcome.refusal.journalCode === "STALE_PARENT") forget();
      return outcome;
    }
    if (outcome.status === "recoveryRequired") {
      forget();
      return { status: "recoveryRequired", error: outcome.error };
    }
    if (outcome.basis === null) forget();
    else if (isJournalTabLive(tabId, life)) rememberJournalBasis(tabId, docKey, outcome.basis);
    if (outcome.status === "aborted") {
      if (outcome.basis !== null) freeze?.recorded(outcome.basis);
      if (outcome.thrown) throw outcome.thrown.error;
      return { status: "aborted", reason: outcome.reason };
    }
    if (outcome.basis === outcome.revision) for (const f of forks) f.recorded(outcome.revision);
    if (outcome.status === "appliedWithError") {
      return { status: "appliedWithError", error: outcome.error, durable: outcome.durable, changed: true, resolves };
    }
    return { status: "applied", durable: outcome.durable, changed: outcome.value, resolves };
  } finally {
    // The first settlement wins, so this only reaches what nothing recorded.
    for (const f of forks) f.invalidate();
    freeze?.invalidate();
  }
}
