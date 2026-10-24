/**
 * Restore verdict — what the history panel tells the user about a restore's
 * outcome, classified once for both of its restore buttons (a revision of
 * the open document, and an earlier checkpoint).
 *
 * Key decisions:
 *   - Only the problems are shared: an apply that threw after changing the
 *     buffer warns, one that could not be confirmed says the document needs
 *     recovery, and anything else that is not an apply failed. The success
 *     wording (and a checkpoint's fallback) differs per button, so a clean
 *     apply is returned to the caller with whether it changed the text.
 *   - Pure: the caller translates the key and raises the toast.
 *
 * @coordinates-with services/agentJournal/historyRestore.ts — the outcome
 * @coordinates-with DocumentHistoryList.tsx — restore a revision
 * @coordinates-with EarlierCheckpoints.tsx — restore an earlier checkpoint
 * @module components/McpHistory/restoreVerdict
 */

import type { HistoryRestoreOutcome } from "@/services/agentJournal/historyRestore";

type RestoreVerdict =
  | { kind: "applied"; changed: boolean }
  | {
      kind: "problem";
      tone: "warning" | "error";
      key: "mcpHistoryRestoreAppliedWithError" | "mcpHistoryRestoreRecoveryRequired" | "mcpHistoryRestoreFailed";
    };

/** Classify `outcome`; `null` is a restore that threw before producing one. */
export function classifyRestore(outcome: HistoryRestoreOutcome | null): RestoreVerdict {
  switch (outcome?.status) {
    case "applied":
      return { kind: "applied", changed: outcome.changed };
    case "appliedWithError":
      return { kind: "problem", tone: "warning", key: "mcpHistoryRestoreAppliedWithError" };
    case "recoveryRequired":
      return { kind: "problem", tone: "error", key: "mcpHistoryRestoreRecoveryRequired" };
    default:
      return { kind: "problem", tone: "error", key: "mcpHistoryRestoreFailed" };
  }
}
