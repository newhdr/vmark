/**
 * Purpose: `vmark.selection.{get, set}` handlers — targeted edits on the
 *   user's current editor selection without paying the full-doc round-trip
 *   that `document.{read, write}` requires on large files.
 *
 *   Restored after the MCP pruning. See ADR-7 in
 *   `.claude/adr/plans/20260504-mcp-pruning.md` for the cost analysis that
 *   motivated re-adding it.
 *
 * Key decisions:
 *   - Selection is view-state, so the request only operates on the
 *     currently focused editor. The `tabId` arg, when supplied, is
 *     verified to match the focused tab; mismatches return INVALID_TAB.
 *   - WYSIWYG (Tiptap) and source (CodeMirror) are both supported, through
 *     one `SelectionSurface` (`selectionSurface.ts`). The `mode` field in
 *     the response tells the AI which position space the `range` lives in
 *     (PM positions vs. character offsets).
 *   - In WYSIWYG, the response's `text` is the markdown serialization of
 *     the selected slice — same canonical representation the AI uses for
 *     `document.read`. `set` parses incoming markdown and replaces the
 *     selected range with the parsed nodes.
 *   - `set` operates on whatever the editor reports as the *current*
 *     selection at call time. If the user moved the cursor between
 *     `get` and `set`, the edit lands at the new position. The
 *     doc-level revision catches keystrokes; pure cursor movement is
 *     not arbitrated by the server.
 *   - `set` refuses BUSY, changing nothing, while the user is composing with
 *     an input method in the focused editor; `get` is never refused.
 *   - After an edit the mounted editor is flushed at once, and the revision
 *     is bumped last, so the revision returned is still the document's
 *     current one after the editor settles (`liveEditor.ts`).
 *   - `set` runs the journal's controlled-mutation protocol
 *     (`journaledEdit.ts`): nothing changes until the prepare is durable,
 *     and a user edit, selection move, focus switch or composition during
 *     the prepare aborts it — a focus switch even when the request named the
 *     focused tab, since the edit targets the user's selection. The apply
 *     resolves the editor again after the prepare. The commit is a
 *     whole-document barrier: no operation map is claimed for the
 *     replacement. A replacement the surface proves changes nothing
 *     (`wouldChange`) is answered before the prepare with the current
 *     revision. An apply that throws is read back with the editor mirrored
 *     into the store first (`journaledEdit.ts` answers it).
 *
 * @coordinates-with selectionSurface.ts — the WYSIWYG / Source editor adapter
 * @coordinates-with tabGuard.ts — focused-tab resolution, INVALID_TAB and STALE
 * @coordinates-with liveEditor.ts — the flush that keeps the returned revision current
 * @coordinates-with journaledEdit.ts — the journal protocol `set` runs
 * @coordinates-with stores/documentStore/revision.ts — optimistic concurrency
 * @module services/mcpBridge/v2/selection
 */

import type { McpWriteContext } from "@/services/mcpBridge/writeContext";
import { useDocumentStore, useRevisionStore } from "@/stores/documentStore";
import { respond } from "@/services/mcpBridge/utils";
import { wrapHandler } from "./wrapHandler";
import { flushLiveEditors } from "./liveEditor";
import { readOperationArgs } from "./readOperationArgs";
import { resolveSelectionSurface, type SelectionSurface } from "./selectionSurface";
import { requireCurrentRevision, requireTab, structuredError, type GuardedTab } from "./tabGuard";
import { runJournaledEdit } from "./journaledEdit";
import { invalidTextError } from "./journalV2Error";
import { isWellFormedText } from "@/services/agentJournal/wellFormedText";

/**
 * Handle `vmark.selection.get`. Args: `{tabId?: string}`.
 */
export async function handleSelectionGet(
  id: string,
  args: Record<string, unknown>,
): Promise<void> {
  return wrapHandler(id, async () => {
    const wire = readOperationArgs("vmark.selection.get", args);
    const tab = await requireTab(id, wire.tabId, "focused");
    if (!tab) return;
    const surface = resolveSelectionSurface(tab.tabId);
    if ("error" in surface) {
      await structuredError(id, surface);
      return;
    }

    const range = surface.range();
    await respond({
      id,
      success: true,
      data: {
        text: surface.selectedText(),
        isEmpty: range.from === range.to,
        range,
        mode: surface.mode,
        kind: tab.kind,
        tabId: tab.tabId,
        revision: useRevisionStore.getState().getRevision(tab.tabId),
      },
    });
  });
}

/**
 * Replace the focused selection of `tabId` now, synchronously, and mirror
 * the editor into the store: the journaled edit's apply. The surface is
 * resolved again here, after the prepare, so the edit never lands in an
 * editor that was swapped out meanwhile.
 */
function applySelectionEdit(tabId: string, content: string) {
  const surface = resolveSelectionSurface(tabId);
  if ("error" in surface) return { refused: "selection" as const };
  // The prepare awaited: a composition may have started since.
  if (surface.writeRefusal()) return { refused: "composing" as const };
  surface.replaceSelection(content);
  // Flush the mounted editor NOW: the store then holds its serialization
  // and the editor knows it, so its content sync does not parse and load
  // the same document again.
  flushLiveEditors();
  // Mirror the editor into the store. After a flush this is the same text;
  // it is what covers an editor that has no flusher registered.
  const contentAfter = surface.documentText();
  useDocumentStore.getState().setEditorContent(tabId, contentAfter);
  const revisionAfter = useRevisionStore.getState().updateRevision(tabId);
  const postimage = useDocumentStore.getState().documents[tabId]?.content ?? contentAfter;
  return { postimage, value: revisionAfter };
}

/**
 * After an apply that threw: mirror the editor into the store, so the
 * journal reads back what the editor actually holds. No editor left: the
 * store is all there is.
 */
function recoverSelectionEdit(tabId: string): void {
  const surface = resolveSelectionSurface(tabId);
  if ("error" in surface) return;
  const text = surface.documentText();
  if (text !== useDocumentStore.getState().documents[tabId]?.content) {
    useDocumentStore.getState().setEditorContent(tabId, text);
  }
}

/** A `set` request admitted against the focused editor, ready to run. */
interface PreparedSelectionSet {
  tab: GuardedTab;
  surface: SelectionSurface;
  content: string;
}

/**
 * Admit a `set` request, in order: payload, focused tab, editor surface,
 * expected revision, composition, well-formed text. Answers the first
 * refusal itself and returns null; nothing has changed either way.
 */
async function prepareSelectionSet(id: string, args: Record<string, unknown>): Promise<PreparedSelectionSet | null> {
  const wire = readOperationArgs("vmark.selection.set", args);
  if (wire.content === undefined) {
    await structuredError(id, { error: "INTERNAL", message: "content must be a string" });
    return null;
  }
  const tab = await requireTab(id, wire.tabId, "focused");
  if (!tab) return null;
  const surface = resolveSelectionSurface(tab.tabId);
  if ("error" in surface) {
    await structuredError(id, surface);
    return null;
  }
  if (!(await requireCurrentRevision(id, tab.tabId, wire.expected_revision))) return null;
  // Asked after the last await, so nothing can start a composition between
  // the answer and the replacement.
  const refusal = surface.writeRefusal() ?? (isWellFormedText(wire.content) ? null : invalidTextError());
  if (refusal) {
    await structuredError(id, refusal);
    return null;
  }
  return { tab, surface, content: wire.content };
}

/**
 * Handle `vmark.selection.set`.
 *
 * Args: `{tabId?, content: string, expected_revision?: string}`.
 *
 * Runs through the edit journal's controlled-mutation protocol
 * (`journaledEdit.ts`) and answers `applied` + `durable`; `context` is the
 * revision's actor. A provable no-op (`SelectionSurface.wouldChange`)
 * journals, dispatches and bumps nothing.
 */
export async function handleSelectionSet(
  id: string,
  args: Record<string, unknown>,
  context: McpWriteContext,
): Promise<void> {
  return wrapHandler(id, async () => {
    const prepared = await prepareSelectionSet(id, args);
    if (!prepared) return;
    const { tab, surface, content } = prepared;
    const selectedText = surface.selectedText();
    if (!surface.wouldChange(content)) {
      // A provable no-op (an empty selection deleted, or the selection
      // replaced by what it already holds): nothing to journal or bump.
      const revision = useRevisionStore.getState().getRevision(tab.tabId);
      await respond({ id, success: true, data: { revision, replaced_chars: 0 } });
      return;
    }
    const contentBefore = surface.documentText();
    // The journal's preimage is the store's buffer, flushed from the editor.
    flushLiveEditors();
    const preimage = useDocumentStore.getState().documents[tab.tabId]?.content ?? contentBefore;

    const outcome = await runJournaledEdit(id, {
      tab,
      preimage,
      // Selection is view-state: the edit stays on the focused tab whether
      // or not the request named it.
      requireFocus: true,
      tool: "selection.set",
      context,
      apply: () => applySelectionEdit(tab.tabId, content),
      recover: () => recoverSelectionEdit(tab.tabId),
    });
    if (!outcome) return;
    await respond({
      id,
      success: true,
      data: { revision: outcome.value, replaced_chars: selectedText.length, applied: true, durable: outcome.durable },
    });
  });
}
