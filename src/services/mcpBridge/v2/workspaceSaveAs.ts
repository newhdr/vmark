/**
 * Purpose: `vmark.workspace.save_as` handler.
 *
 * Kept separate from `workspace.ts` because save-as carries the bridge's
 * approval, path-boundary and overwrite policy.
 *
 * Key decision: `autoApproveEdits` authorises saving to a NEW location, never
 * destroying an existing one. The allowed roots include the parent directory
 * of every open document, so without that split an auto-approved save_as
 * could silently overwrite any sibling of any open file.
 *
 * Key decision: overwrite protection does not rest on the `exists` probe
 * alone. A save to a destination other than the tab's own path is written
 * with `noReplace`, so a file created after the probe is kept and the request
 * is refused with the same APPROVAL_REQUIRED reply. Its toast states the
 * overwrite rule, not the auto-approve setting: no setting permits it.
 *
 * Key decision: the write itself is the app's own save (`bridgeSave.ts`). The
 * save pipeline re-points the document and its tab at the new path, and only
 * when this save is still the newest one requested for the document — so an
 * autosave to the old path that lands later cannot pull the tab back, and of
 * two Save As requests the one ASKED for last wins: the request reserves its
 * place in the document's save order when admitted, before the path guard,
 * approval and overwrite checks await, so a request delayed there cannot rank
 * last; the save pipeline activates that place only once the write has
 * succeeded, so a request refused here, by the queued path guard or by the
 * no-replace publication, or whose write fails, never supersedes an earlier
 * Save As still in flight. It also keeps the
 * document's line endings and byte-order mark, records history, and captures
 * provenance under the capture-on-save setting like every other MCP write.
 * The reply's `journaled` says whether the agent edit journal recorded the
 * saved text ("yes" | "pending" | "no"); "no" is still a saved file.
 *
 * @coordinates-with tabGuard.ts — tab resolution, the flush, INVALID_TAB
 * @coordinates-with bridgeSave.ts — the path guard and the save pipeline
 * @coordinates-with services/persistence/saveTargetClaim.ts — the place reserved at admission, activated once written
 * @coordinates-with liveEditor.ts — flushes pending keystrokes into the buffer first
 * @coordinates-with services/persistence/applyPostSaveState.ts — re-points the document and tab
 * @module services/mcpBridge/v2/workspaceSaveAs
 */

import { exists } from "@tauri-apps/plugin-fs";
import { useDocumentStore, useRevisionStore } from "@/stores/documentStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { getFileName, normalizePath } from "@/utils/paths";
import { checkBridgePath } from "@/services/mcpBridge/bridgePathGuard";
import { isSameDocument, reserveSaveTarget } from "@/services/persistence/saveTargetClaim";
import type { McpWriteContext } from "@/services/mcpBridge/writeContext";
import { imeToast } from "@/services/ime/imeToast";
import i18n from "@/i18n";
import { respond } from "@/services/mcpBridge/utils";
import { wrapHandler } from "./wrapHandler";
import { overwriteRefusal, respondSaveFailed, saveTabForBridge } from "./bridgeSave";
import { flushLiveEditors } from "./liveEditor";
import { readOperationArgs } from "./readOperationArgs";
import { requireTab, structuredError } from "./tabGuard";

/** Tell the user an AI client's Save As to `name` needs their approval. */
function warnApprovalRequired(name: string): void {
  imeToast.warning(i18n.t("dialog:toast.mcpApprovalRequired", { filename: name }));
}

/** Tell the user an AI client's Save As over the existing `name` was refused:
 *  no setting allows it, so the toast names the remedies that do. */
function warnOverwriteRefused(name: string): void {
  imeToast.warning(i18n.t("dialog:toast.mcpOverwriteRefused", { filename: name }));
}

/**
 * Handle `vmark.workspace.save_as`. Args: `{tabId?, filePath}`.
 *
 * `context` names the client asking; the save's provenance records it as the
 * writer, with the documents it read on its connection as inputs.
 */
export async function handleWorkspaceSaveAs(
  id: string,
  args: Record<string, unknown>,
  context: McpWriteContext,
): Promise<void> {
  return wrapHandler(id, async () => {
    const wire = readOperationArgs("vmark.workspace.save_as", args);
    const filePath = wire.filePath;
    // A value of the wrong type reads as absent; an empty path names nothing.
    if (!filePath) {
      await structuredError(id, {
        error: "INVALID_PATH",
        message: "filePath must be a non-empty string",
      });
      return;
    }

    // Admission: the request's place in the document's save order is
    // reserved before the guard, approval and overwrite checks await
    // (resolving the tab yields only a microtask), so a request delayed in
    // them cannot rank after — and override — a Save As the client sent
    // later. It is activated only once every refusal check has passed.
    const tab = await requireTab(id, wire.tabId);
    if (!tab) return;
    const { tabId } = tab;
    const reservation = reserveSaveTarget(tabId);

    const decision = await checkBridgePath(filePath);
    if (!decision.allowed) {
      await structuredError(id, {
        error: "INVALID_PATH",
        message: decision.reason,
      });
      return;
    }

    const autoApprove =
      useSettingsStore.getState().advanced.mcpServer.autoApproveEdits;
    const sameOpenPath =
      tab.filePath != null &&
      normalizePath(tab.filePath) === normalizePath(filePath);
    if (!autoApprove && !sameOpenPath) {
      warnApprovalRequired(getFileName(filePath) || filePath);
      await structuredError(id, {
        error: "APPROVAL_REQUIRED",
        message:
          "Saving to a new location requires user approval (autoApproveEdits is off)",
      });
      return;
    }

    // `autoApproveEdits` authorises saving to a NEW location — it does
    // not authorise destroying an existing one. The bridge's allowed roots
    // include the parent directory of every open document, so without this an
    // auto-approved save_as could silently overwrite any sibling of any open
    // file. Saving over the tab's own path is a save, not a clobber.
    // The probe is the fast path; the write below is the guarantee. A file
    // created after the probe is met by the no-replace publication and
    // refused the same way.
    const name = getFileName(filePath) || filePath;
    if (!sameOpenPath && (await exists(filePath))) {
      warnOverwriteRefused(name);
      await structuredError(id, { error: "APPROVAL_REQUIRED", message: overwriteRefusal(name) });
      return;
    }

    // Read the buffer NOW, after flushing pending keystrokes into it: the
    // approval checks above awaited, and the user may have kept typing — or
    // closed the tab, in which case there is nothing left to save and the
    // copy resolved earlier must not be written out in its place.
    // @edge-case A tab closed and its id reopened meanwhile holds ANOTHER
    // document: the reservation's incarnation tells them apart, the id cannot.
    flushLiveEditors();
    const live = useDocumentStore.getState().documents[tabId];
    if (!live || !isSameDocument(reservation.reserved)) {
      await structuredError(id, { error: "INVALID_TAB", message: "No document for tab" });
      return;
    }
    const outcome = await saveTabForBridge(tabId, filePath, live.content, "workspace.save_as", context, {
      reservation,
      noReplace: !sameOpenPath,
    });
    if (!outcome.saved) {
      if (outcome.reason === "target-exists") warnOverwriteRefused(name);
      await respondSaveFailed(id, outcome);
      return;
    }
    const revision = useRevisionStore.getState().getRevision(tabId);
    await respond({ id, success: true, data: { revision, journaled: outcome.journaled } });
  });
}
