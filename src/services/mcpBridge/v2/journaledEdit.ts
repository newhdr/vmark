/**
 * Journaled edit — run one MCP edit of a tab's buffer through the agent
 * edit journal's controlled-mutation protocol: the shared core of
 * `document.write`, `document.transform`, `selection.set` and
 * `workflow.apply_patch`.
 *
 * Pipeline: capture the write target → freeze the tab's unsaved provenance
 * at the exact preimage → journal prepare (durable; takes the document's reservation and records any
 * unjournaled buffer text as the user's) → re-verify the tab
 * (`writeTarget.ts`) → the caller's apply → fork the provenance window onto
 * the applied text → journal commit → settle the freeze and the fork → keep
 * the tab's journal basis.
 *
 * Key decisions:
 *   - Every tool's commit is a whole-document barrier: none of them hands
 *     the journal an operation map. `document.write` and `document.transform`
 *     replace the whole text; `workflow.apply_patch` re-stringifies a YAML
 *     tree; `selection.set` in WYSIWYG re-serializes the whole document. A
 *     map the journal could certify would need an armed editing epoch and a
 *     postimage-exact op list for each of these, so the journal records the
 *     conservative barrier rather than a guessed mapping (fail closed).
 *   - Refusals and aborts are answered here, so a caller only sees the
 *     applied outcome; `null` means the request has been answered.
 *   - The prepare carries the frozen window's certified map and whether a
 *     person touched it, so an equal-text buffer that was retyped is still
 *     recorded as the user's. The apply forks the window onto the applied
 *     text in the same synchronous step, so the edit's own change is never
 *     certified as a person's. The fork is recorded at the committed
 *     revision, or invalidated when the commit was refused (its successors
 *     then carry a snapshotOnly barrier). An abort records the freeze at the
 *     baseline its prepare recorded. Anything left unsettled is invalidated.
 *   - A basis evicted from the bounded identity table refuses STALE_PARENT
 *     before anything is sent: the retry rebases on the journal's head
 *     instead of writing without a compare-and-set.
 *   - A STALE_PARENT refusal (or a commit the journal refused with no basis)
 *     drops the tab's basis, so a retry rebases.
 *   - The tab's journal lifecycle token is taken before the first await;
 *     a tab closed (and perhaps reopened under the same id) by the time the
 *     journal answers gets no basis remembered or forgotten for it.
 *   - An apply that throws is read back, never assumed undone
 *     (`controlledMutation.ts`): the store's buffer, after the caller's
 *     `recover` brings it into agreement with the editor. A changed buffer
 *     bumps the revision, forks the provenance window like an applied edit,
 *     is committed, and is answered INTERNAL with `applied: true` and
 *     `durable`; an unreadable one is answered INTERNAL without `applied`
 *     (the journal keeps the transaction open) and drops the basis. An
 *     unchanged one is an abort: the basis and freeze settle as for any
 *     abort (a recorded baseline is kept), then the error is rethrown.
 *   - The journal key is the one the request's guards saw: the capture
 *     aborts (`closed`) if a Save As or rename moved it before the edit
 *     starts, and the re-verify if one moved it during the prepare, so the
 *     edit is never prepared or committed under a key the guards did not see
 *     or the tab no longer holds.
 *   - The awaited provenance payload is followed by the same identity and
 *     content check, so the prepare never carries a preimage or key that
 *     changed while it was computed.
 *
 * @coordinates-with services/agentJournal/controlledMutation.ts — the protocol
 * @coordinates-with services/agentJournal/unsavedProvenance.ts — the freeze and fork
 * @coordinates-with writeTarget.ts — the re-verify
 * @coordinates-with journalV2Error.ts — refusal and abort answers
 * @module services/mcpBridge/v2/journaledEdit
 */

import type { McpWriteContext } from "@/services/mcpBridge/writeContext";
import { useDocumentStore, useRevisionStore } from "@/stores/documentStore";
import type { AbortReason } from "@/services/agentJournal/journalClient";
import { runControlledWrite } from "@/services/agentJournal/controlledMutation";
import { journalActorFor } from "@/services/agentJournal/journalActor";
import { JournalRefusal } from "@/services/agentJournal/journalRefusal";
import { forkUnsavedProvenance, freezeUnsavedProvenance } from "@/services/agentJournal/unsavedProvenance";
import type { ProvenanceFork } from "@/services/agentJournal/provenance/session";
import {
  forgetJournalBasis,
  isJournalBasisEvicted,
  isJournalTabLive,
  journalBasis,
  journalTabLife,
  rememberJournalBasis,
} from "@/services/agentJournal/documentIdentity";
import { structuredError } from "./tabGuard";
import { captureWriteTarget, recheckWriteTarget, reverifyWriteTarget } from "./writeTarget";
import { abortedError, appliedWithErrorError, journalRefusalError, recoveryRequiredError } from "./journalV2Error";

export interface JournaledEdit<T> {
  /** The tab as the request's guards resolved it (`GuardedTab`). */
  tab: { tabId: string; revision: string; filePath: string | null };
  /** The buffer as the store holds it now (flushed): the prepare's preimage. */
  preimage: string;
  /**
   * The edit must still be on the focused tab when the prepare answers (a
   * request that named no tab, or a selection edit): a focus switch aborts it.
   */
  requireFocus: boolean;
  /** The tool name recorded on the revision (`document.transform`, …). */
  tool: string;
  context: McpWriteContext;
  /**
   * Apply now, synchronously. `postimage` is the text the store holds
   * afterwards, read back before any await.
   */
  apply: () => { postimage: string; value: T } | { refused: AbortReason };
  /**
   * After an apply that threw: bring the store into agreement with the
   * editor, synchronously. Omitted when the store is the document's truth.
   */
  recover?: () => void;
}

/** The buffer the store holds for `tabId`; throws once the tab is gone. */
function storeText(tabId: string): string {
  const text = useDocumentStore.getState().documents[tabId]?.content;
  if (text === undefined) throw new Error(`tab ${tabId} has no document`);
  return text;
}

/** The applied edit, or `null` when the request was refused or aborted (already answered). */
export async function runJournaledEdit<T>(
  id: string,
  edit: JournaledEdit<T>,
): Promise<{ value: T; durable: boolean } | null> {
  const { tab } = edit;
  // Taken before the first await: a tab closed and reopened under the same id
  // while the journal answers is another tab, whose basis this edit must not
  // remember or forget into.
  const life = journalTabLife(tab.tabId);
  const target = captureWriteTarget(tab, edit.requireFocus, edit.preimage);
  if ("refused" in target) {
    await structuredError(id, abortedError(target.refused));
    return null;
  }
  // The key the guards saw, still held by the tab (the capture refused a Save As in between).
  const { docKey } = target;
  if (isJournalBasisEvicted(tab.tabId, docKey)) {
    forgetJournalBasis(tab.tabId, docKey);
    const evicted = new JournalRefusal("STALE_PARENT", "the tab's journal basis was evicted; re-read and retry");
    await structuredError(id, journalRefusalError(evicted));
    return null;
  }
  const parent = journalBasis(tab.tabId, docKey);
  const freeze = freezeUnsavedProvenance(tab.tabId, edit.preimage);
  const forks: ProvenanceFork[] = [];
  const fork = (postimage: string): void => {
    const f = forkUnsavedProvenance(tab.tabId, postimage);
    if (f) forks.push(f);
  };
  try {
    const named = freeze ? await freeze.payload(parent) : null;
    // The payload awaited: the prepare must carry the tab's text and key as they are now.
    const changed = freeze ? recheckWriteTarget(target) : null;
    if (changed) {
      await structuredError(id, abortedError(changed));
      return null;
    }
    /** Record what the journal answered, unless the tab closed since. */
    const settleBasis = (basis: string | null): void => {
      if (!isJournalTabLive(tab.tabId, life)) return;
      if (basis === null) forgetJournalBasis(tab.tabId, docKey);
      else rememberJournalBasis(tab.tabId, docKey, basis);
    };
    const outcome = await runControlledWrite({
      prepare: {
        docKey,
        parent,
        preimage: edit.preimage,
        actor: journalActorFor(edit.context.attribution),
        tool: edit.tool,
        baselineProvenance: named?.payload ?? null,
        baselineTouched: freeze?.touched ?? false,
      },
      verify: () => reverifyWriteTarget(target),
      apply: () => {
        const applied = edit.apply();
        if ("postimage" in applied) fork(applied.postimage);
        return applied;
      },
      recover: () => {
        edit.recover?.();
        const postimage = storeText(tab.tabId);
        if (postimage !== edit.preimage) {
          useRevisionStore.getState().updateRevision(tab.tabId);
          fork(postimage);
        }
        return postimage;
      },
    });

    if (outcome.status === "refused") {
      if (outcome.refusal.journalCode === "STALE_PARENT") settleBasis(null);
      await structuredError(id, journalRefusalError(outcome.refusal));
      return null;
    }
    if (outcome.status === "recoveryRequired") {
      settleBasis(null);
      await structuredError(id, recoveryRequiredError(outcome.error));
      return null;
    }
    settleBasis(outcome.basis);
    if (outcome.status === "aborted") {
      if (outcome.basis !== null) freeze?.recorded(outcome.basis);
      if (outcome.thrown) throw outcome.thrown.error;
      await structuredError(id, abortedError(outcome.reason));
      return null;
    }
    if (outcome.basis === outcome.revision) for (const f of forks) f.recorded(outcome.revision);
    if (outcome.status === "appliedWithError") {
      const current = useRevisionStore.getState().getRevision(tab.tabId);
      await structuredError(id, appliedWithErrorError(outcome.error, outcome.durable, current));
      return null;
    }
    return { value: outcome.value, durable: outcome.durable };
  } finally {
    // The first settlement wins, so this only reaches what nothing recorded.
    for (const f of forks) f.invalidate();
    freeze?.invalidate();
  }
}
