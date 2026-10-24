/**
 * Purpose: `vmark.workflow.{apply_patch, validate}` handlers — the
 *   only structural mutators that survive the MCP prune.
 *
 *   `apply_patch` accepts an array of IRPatch objects (the existing
 *   discriminated union from `lib/ghaWorkflow/save/mutators.ts`) and
 *   applies them through the CST-safe path so YAML comments, anchors,
 *   and key order are preserved. `validate` runs actionlint and
 *   forwards diagnostics.
 *
 * Origin: MCP pruning plan (retired) ADR-5.
 *
 * Key decisions:
 *   - `IRPatch` is a public contract once exposed via MCP. We accept
 *     the existing shape verbatim; future breaking changes bump to
 *     `apply_patch_v2`. Validate the discriminator client-side and
 *     return INVALID_PATCH when the shape is wrong.
 *   - `validate` uses the same actionlint wrapper the live editor
 *     uses, so diagnostics surface identically across UI and MCP.
 *   - Only `yaml-workflow` tabs accept `apply_patch`. Markdown tabs
 *     return NOT_WORKFLOW — the AI must fall back to `document.write`.
 *   - Both handlers resolve their tab through `tabGuard.ts`, which first
 *     flushes the mounted editors into the store — so a patch is applied to,
 *     and a lint runs over, the text the user actually has, pending
 *     keystrokes included.
 *
 * @coordinates-with tabGuard.ts — tab resolution, the flush, INVALID_TAB and STALE
 * @coordinates-with journaledEdit.ts — the journal protocol `apply_patch` runs (a whole-document barrier)
 * @coordinates-with lib/ghaWorkflow/save/cstParser.ts — parseAsCst / stringifyCst
 * @coordinates-with lib/ghaWorkflow/save/mutators.ts — applyPatch + IRPatch types
 * @coordinates-with lib/ghaWorkflow/lint/actionlint.ts — lintWithActionlint
 * @coordinates-with stores/documentStore/revision.ts — the revision token
 * @module services/mcpBridge/v2/workflow
 */

import type { McpWriteContext } from "@/services/mcpBridge/writeContext";
import { useDocumentStore, useRevisionStore } from "@/stores/documentStore";
import {
  parseAsCst,
  stringifyCst,
} from "@/lib/ghaWorkflow/save/cstParser";
import { applyPatch, type IRPatch } from "@/lib/ghaWorkflow/save/mutators";
import { lintWithActionlint } from "@/lib/ghaWorkflow/lint/actionlint";
import { useSettingsStore } from "@/stores/settingsStore";
import { respond } from "@/services/mcpBridge/utils";
import { wrapHandler } from "./wrapHandler";
import { readOperationArgs } from "./readOperationArgs";
import {
  requireCurrentRevision,
  requireTab,
  structuredError,
  type GuardedTab,
} from "./tabGuard";
import type { V2Error } from "./types";
import { runJournaledEdit } from "./journaledEdit";
import { invalidTextError } from "./journalV2Error";
import { isWellFormedText } from "@/services/agentJournal/wellFormedText";
import { errorMessage } from "@/utils/errorMessage";

const VALID_PATCH_KINDS: ReadonlySet<string> = new Set([
  "workflow.set",
  "job.set",
  "step.set",
  "with.set",
  "with.remove",
  "needs.add",
  "needs.remove",
  "trigger.setFilters",
]);

/**
 * Validate that `value` looks like an `IRPatch[]` we can dispatch.
 * The shape check is structural — runtime YAML clients can't import
 * the TypeScript type so we duck-type the discriminator.
 */
function validatePatches(value: unknown): IRPatch[] | V2Error {
  if (!Array.isArray(value)) {
    return {
      error: "INVALID_PATCH",
      message: "patches must be an array",
    };
  }
  for (const [i, p] of value.entries()) {
    if (!p || typeof p !== "object") {
      return {
        error: "INVALID_PATCH",
        message: `patches[${i}] must be an object`,
      };
    }
    const kind = (p as { kind?: unknown }).kind;
    if (typeof kind !== "string" || !VALID_PATCH_KINDS.has(kind)) {
      return {
        error: "INVALID_PATCH",
        message: `patches[${i}].kind is missing or invalid: ${String(kind)}`,
      };
    }
  }
  return value as IRPatch[];
}

/**
 * Resolve the request's tab and require it to be a workflow, or answer the
 * refusal (`INVALID_TAB`, `NOT_WORKFLOW`) and return `null`.
 */
async function requireWorkflowTab(
  id: string,
  tabIdArg: string | undefined,
): Promise<GuardedTab | null> {
  const tab = await requireTab(id, tabIdArg);
  if (!tab) return null;
  if (tab.kind !== "yaml-workflow") {
    await structuredError(id, {
      error: "NOT_WORKFLOW",
      message:
        "Tab is not a GitHub Actions workflow YAML; use document.write instead",
    });
    return null;
  }
  return tab;
}

/**
 * Handle `vmark.workflow.apply_patch`.
 *
 * Args: `{tabId?, patches: IRPatch[], expected_revision?}`.
 *
 * Runs through the edit journal's controlled-mutation protocol
 * (`journaledEdit.ts`) and answers `applied` + `durable`; `context` is the
 * revision's actor. A no-op patch batch journals nothing.
 */
export async function handleWorkflowApplyPatch(
  id: string,
  args: Record<string, unknown>,
  context: McpWriteContext,
): Promise<void> {
  return wrapHandler(id, async () => {
    const wire = readOperationArgs("vmark.workflow.apply_patch", args);

    const patchesOrError = validatePatches(wire.patches);
    if (!Array.isArray(patchesOrError)) {
      await structuredError(id, patchesOrError);
      return;
    }
    const patches = patchesOrError;

    const tab = await requireWorkflowTab(id, wire.tabId);
    if (!tab) return;
    if (!(await requireCurrentRevision(id, tab.tabId, wire.expected_revision))) return;

    let nextContent: string;
    try {
      const cst = parseAsCst(tab.content);
      for (const patch of patches) {
        applyPatch(cst, patch);
      }
      nextContent = stringifyCst(cst);
    } catch (e) {
      await structuredError(id, {
        error: "INVALID_PATCH",
        message: `Patch application failed: ${
          errorMessage(e)
        }`,
      });
      return;
    }

    const revisionStore = useRevisionStore.getState();
    const revisionBefore = revisionStore.getRevision(tab.tabId);
    if (nextContent === tab.content) {
      // No-op patch batch — don't bump revision.
      await respond({ id, success: true, data: { revision: revisionBefore } });
      return;
    }

    if (!isWellFormedText(nextContent)) {
      await structuredError(id, invalidTextError());
      return;
    }

    const outcome = await runJournaledEdit(id, {
      tab,
      preimage: tab.content,
      requireFocus: !wire.tabId,
      tool: "workflow.apply_patch",
      context,
      apply: () => {
        useDocumentStore.getState().setEditorContent(tab.tabId, nextContent);
        // Bumped here, last, so the token returned is the document's newest.
        const revisionAfter = revisionStore.updateRevision(tab.tabId);
        const postimage = useDocumentStore.getState().documents[tab.tabId]?.content ?? nextContent;
        return { postimage, value: revisionAfter };
      },
    });
    if (!outcome) return;
    const revisionAfter = outcome.value;

    await respond({
      id,
      success: true,
      data: { revision: revisionAfter, applied: true, durable: outcome.durable },
    });
  });
}

/**
 * Handle `vmark.workflow.validate`. Args: `{tabId?: string}`.
 *
 * Runs actionlint over the workflow YAML and returns diagnostics.
 * Markdown tabs return `NOT_WORKFLOW`.
 */
export async function handleWorkflowValidate(
  id: string,
  args: Record<string, unknown>,
): Promise<void> {
  return wrapHandler(id, async () => {
    const wire = readOperationArgs("vmark.workflow.validate", args);
    const tab = await requireWorkflowTab(id, wire.tabId);
    if (!tab) return;
    if (!useSettingsStore.getState().advanced.workflowActionlint) {
      await respond({
        id,
        success: true,
        data: {
          ok: true,
          diagnostics: [],
          binaryAvailable: false,
          error: "actionlint disabled in settings",
        },
      });
      return;
    }
    const outcome = await lintWithActionlint(tab.content);
    const diagnostics = outcome.diagnostics.map((d) => ({
      line: d.position?.startLine ?? 0,
      col: d.position?.startCol ?? 0,
      message: d.message,
      severity: d.severity,
    }));
    await respond({
      id,
      success: true,
      data: {
        ok: diagnostics.length === 0 && !outcome.error,
        diagnostics,
        binaryAvailable: outcome.binaryAvailable,
        error: outcome.error,
      },
    });
  });
}
