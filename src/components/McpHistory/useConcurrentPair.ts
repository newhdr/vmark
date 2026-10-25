/**
 * Concurrent pair loader — loads, on demand, both diffs of a revision edited
 * in two windows: the saving window's own change (observed before → result)
 * and the change against the version before it (linear before → result).
 *
 * Key decisions:
 *   - Nothing is read until the pair is opened. A loaded pair is kept for
 *     the life of the row, so hiding and showing it again reads nothing; a
 *     failed read is forgotten on hide, so the next open retries.
 *   - Each load has its own token: a reply that lands after the pair was
 *     hidden, or after the row unmounted, is dropped rather than shown.
 *   - The diffs run in the review's budgeted worker (`BudgetedDiff`) with
 *     `PAIR_DEADLINE_MS` per diff, counted from each call; one the worker
 *     cannot finish, or cannot start, comes back as one coarse change and
 *     is marked `coarse`. The worker pair is closed when the load ends.
 *   - What is shown is bounded by `pairDiffView` whatever the document size.
 *
 * @coordinates-with services/agentJournal/concurrentPairClient.ts — the read
 * @coordinates-with services/agentJournal/review/budgetedDiff.ts — the diff
 * @coordinates-with components/McpHistory/pairDiffView.ts — the bounded layout
 * @module components/McpHistory/useConcurrentPair
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { readConcurrentPair } from "@/services/agentJournal/concurrentPairClient";
import { BudgetedDiff } from "@/services/agentJournal/review/budgetedDiff";
import type { DiffOutcome } from "@/services/agentJournal/review/diffBudget";
import { journalWarn } from "@/utils/debug";
import { diffView, type DiffView } from "./pairDiffView";

/** How long one of the two diffs may take, from its call, before it is shown coarse. */
const PAIR_DEADLINE_MS = 1_000;

export interface PairDiff {
  readonly view: DiffView;
  /** The worker could not split the change; it is shown as one. */
  readonly coarse: boolean;
}

export type PairLoad =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "failed" }
  | { readonly status: "ready"; readonly fromStart: PairDiff; readonly against: PairDiff };

const pairDiff = (a: string, b: string, outcome: DiffOutcome): PairDiff => ({
  view: diffView(a, b, outcome.changes),
  coarse: outcome.mode === "tooComplex",
});

/** Both diffs of concurrent `revision`. Rejects when the read is refused or a text is not well-formed. */
async function loadPairDiffs(docKey: string, revision: string): Promise<{ fromStart: PairDiff; against: PairDiff }> {
  const pair = await readConcurrentPair(docKey, revision);
  const diff = new BudgetedDiff();
  try {
    const [fromStart, against] = await Promise.all([
      diff.diff(pair.observedBefore, pair.result, { deadlineMs: PAIR_DEADLINE_MS }),
      diff.diff(pair.linearBefore, pair.result, { deadlineMs: PAIR_DEADLINE_MS }),
    ]);
    return { fromStart: pairDiff(pair.observedBefore, pair.result, fromStart), against: pairDiff(pair.linearBefore, pair.result, against) };
  } finally {
    diff.close();
  }
}

/** Whether the pair is open, what has loaded, and the toggle. */
export function useConcurrentPair(docKey: string, revision: string): { open: boolean; load: PairLoad; toggle: () => void } {
  const [open, setOpen] = useState(false);
  const [load, setLoad] = useState<PairLoad>({ status: "idle" });
  const token = useRef(0);

  useEffect(
    () => () => {
      token.current += 1;
    },
    [],
  );

  const toggle = useCallback(() => {
    if (open) {
      token.current += 1;
      setOpen(false);
      if (load.status !== "ready") setLoad({ status: "idle" });
      return;
    }
    setOpen(true);
    if (load.status === "ready") return;
    token.current += 1;
    const mine = token.current;
    setLoad({ status: "loading" });
    loadPairDiffs(docKey, revision).then(
      (diffs) => {
        if (token.current === mine) setLoad({ status: "ready", ...diffs });
      },
      (error: unknown) => {
        journalWarn("concurrent pair read failed:", error);
        if (token.current === mine) setLoad({ status: "failed" });
      },
    );
  }, [open, load.status, docKey, revision]);

  return { open, load, toggle };
}
