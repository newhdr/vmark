/**
 * Journaled edit — run one MCP edit of a tab's buffer through the agent
 * edit journal's controlled-mutation protocol: the shared core of
 * `document.write`, `document.transform`, `selection.set` and
 * `workflow.apply_patch`.
 *
 * Pipeline: capture the write target → the journaled-mutation coordinator
 * (`journaledMutation.ts`: evicted-basis refusal, provenance freeze, prepare,
 * verify, apply, commit, basis and provenance settlement) with this file's
 * adapters: the controlled prepare under the request's MCP actor, the
 * write-target re-verify (`writeTarget.ts`), the caller's apply, a store
 * read-back after the caller's `recover`, and the MCP answer.
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
 *     applied outcome; `null` means the request has been answered. An apply
 *     that threw and changed the buffer is answered INTERNAL with
 *     `applied: true` and `durable`; an unreadable one INTERNAL without
 *     `applied`; an unchanged one rethrows the apply's error.
 *   - The tab's journal lifecycle token is taken before the first await;
 *     a tab closed (and perhaps reopened under the same id) by the time the
 *     journal answers gets no basis remembered or forgotten for it.
 *   - The journal key is the one the request's guards saw: the capture
 *     aborts (`closed`) if a Save As or rename moved it before the edit
 *     starts, and the re-verify if one moved it during the prepare, so the
 *     edit is never prepared or committed under a key the guards did not see
 *     or the tab no longer holds.
 *   - The awaited provenance payload is followed by the same identity and
 *     content check (`recheck`), so the prepare never carries a preimage or
 *     key that changed while it was computed.
 *
 * @coordinates-with services/agentJournal/journaledMutation.ts — the coordinator
 * @coordinates-with services/agentJournal/controlledMutation.ts — the controlled prepare
 * @coordinates-with writeTarget.ts — the re-verify
 * @coordinates-with journalV2Error.ts — refusal and abort answers
 * @module services/mcpBridge/v2/journaledEdit
 */

import type { McpWriteContext } from "@/services/mcpBridge/writeContext";
import { useDocumentStore, useRevisionStore } from "@/stores/documentStore";
import { prepareControlledWrite, type AbortReason } from "@/services/agentJournal/journalClient";
import { prepareWithBaselineRetry } from "@/services/agentJournal/controlledMutation";
import { runJournaledMutation, type JournaledOutcome } from "@/services/agentJournal/journaledMutation";
import { journalActorFor } from "@/services/agentJournal/journalActor";
import { journalTabLife } from "@/services/agentJournal/documentIdentity";
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
  return runJournaledMutation({
    tabId: tab.tabId,
    life,
    // The key the guards saw, still held by the tab (the capture refused a Save As in between).
    docKey: target.docKey,
    preimage: edit.preimage,
    retryHint: "re-read and retry",
    recheck: () => recheckWriteTarget(target),
    prepare: (baseline) =>
      prepareWithBaselineRetry(
        {
          docKey: baseline.docKey,
          parent: baseline.parent,
          preimage: baseline.preimage,
          actor: journalActorFor(edit.context.attribution),
          tool: edit.tool,
          baselineProvenance: baseline.baselineProvenance,
          baselineTouched: baseline.baselineTouched,
        },
        prepareControlledWrite,
      ),
    verify: () => reverifyWriteTarget(target),
    apply: edit.apply,
    recover: () => {
      edit.recover?.();
      return storeText(tab.tabId);
    },
    outcome: async (outcome: JournaledOutcome<T>) => {
      switch (outcome.status) {
        case "applied":
          return { value: outcome.value, durable: outcome.durable };
        case "refused":
          await structuredError(id, journalRefusalError(outcome.refusal));
          return null;
        case "aborted":
          await structuredError(id, abortedError(outcome.reason));
          return null;
        case "recoveryRequired":
          await structuredError(id, recoveryRequiredError(outcome.error));
          return null;
        case "appliedWithError": {
          const current = useRevisionStore.getState().getRevision(tab.tabId);
          await structuredError(id, appliedWithErrorError(outcome.error, outcome.durable, current));
          return null;
        }
      }
    },
  });
}
