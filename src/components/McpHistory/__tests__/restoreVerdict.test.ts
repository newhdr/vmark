// @vitest-environment node
/**
 * One classification of a history restore's outcome, shared by the panel's
 * two restore buttons: a clean apply (changed or not), or the problem to
 * report and its tone.
 */
import { describe, it, expect } from "vitest";
import type { HistoryRestoreOutcome } from "@/services/agentJournal/historyRestore";
import { classifyRestore } from "../restoreVerdict";

const applied = (changed: boolean): HistoryRestoreOutcome => ({ status: "applied", durable: true, changed, resolves: null });

describe("classifyRestore", () => {
  it.each([
    ["a changed apply", applied(true), { kind: "applied", changed: true }],
    ["an apply that changed nothing", applied(false), { kind: "applied", changed: false }],
    [
      "an apply that threw after changing the buffer",
      { status: "appliedWithError", error: new Error("x"), durable: true, changed: true, resolves: null },
      { kind: "problem", tone: "warning", key: "mcpHistoryRestoreAppliedWithError" },
    ],
    [
      "an apply that could not be confirmed",
      { status: "recoveryRequired", error: new Error("x") },
      { kind: "problem", tone: "error", key: "mcpHistoryRestoreRecoveryRequired" },
    ],
    [
      "a refusal",
      { status: "refused", refusal: { kind: "NOT_FOUND" } },
      { kind: "problem", tone: "error", key: "mcpHistoryRestoreFailed" },
    ],
    ["an abort", { status: "aborted", reason: "closed" }, { kind: "problem", tone: "error", key: "mcpHistoryRestoreFailed" }],
    ["no outcome (the restore threw)", null, { kind: "problem", tone: "error", key: "mcpHistoryRestoreFailed" }],
  ])("%s", (_name, outcome, expected) => {
    expect(classifyRestore(outcome as HistoryRestoreOutcome | null)).toEqual(expected);
  });
});
