// @vitest-environment node
// WI-AL2.0j — every coordinator await is bounded: a prepare still waiting for its capture turn at the deadline refuses JOURNAL_TIMEOUT and never dispatches once the turn comes; a commit acknowledgement that never settles is applied not durable at the per-call deadline with no abort and no retry, and a late one changes nothing; an abort that never settles keeps the original refusal; readiness, the freeze payload and the prepare share one pre-apply budget, each prepare attempt bounded by the smaller of the per-call deadline and what remains; a timed-out attempt never invokes late; a prepare reply that lands late is aborted once with reason timedOut; the worst case answers within 17 000 ms
// Driven through the real chain — raw `invoke` → `journalIpc` →
// `journalClient` → `runPreparedWrite` → the coordinator — on fake timers.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.unmock("@/services/agentJournal/journalClient");
import { invoke } from "@tauri-apps/api/core";
import { agentJournalEpochFake } from "@/test/agentJournalEpochFake";
import type { NamedPayload } from "../provenance/session";
import { bindJournalDocument } from "../documentBinding";
import { journalBasis } from "../documentIdentity";
import { registerUnsavedProvenanceSource } from "../unsavedProvenance";
import { JOURNAL_DEADLINE_MS, JOURNAL_PREAPPLY_BUDGET_MS } from "../journalDeadline";
import { EFFECTS_DEADLINE_MS, runJournaledMutation, type JournaledOutcome } from "../journaledMutation";
import { KEY, TAB, mutation, resetMutationFixture } from "./journaledMutationFixture";

type Command = "agent_journal_prepare" | "agent_journal_commit" | "agent_journal_abort";

const invokeMock = vi.mocked(invoke);
const TXN = "txn-1";
const REV = "rev-1";
const DOC = "doc-1";
const PREPARED = { doc: DOC, txn: TXN, revision: REV, generation: "1", baseline: null, certified: false, fallbackReason: null };
const COMMITTED = { doc: DOC, revision: REV, applied: true, durable: true, certified: false, fallbackReason: null };
const DEFAULTS: Record<Command, unknown> = {
  agent_journal_prepare: PREPARED,
  agent_journal_commit: COMMITTED,
  agent_journal_abort: { durable: true },
};

const never = (): Promise<never> => new Promise<never>(() => {});

/** A reply the test settles later, by hand. */
function deferred(): { reply: () => Promise<unknown>; resolve: (v: unknown) => void; reject: (e: unknown) => void } {
  let resolve: (v: unknown) => void = () => {};
  let reject: (e: unknown) => void = () => {};
  const promise = new Promise<unknown>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { reply: () => promise, resolve, reject };
}

/** Answer each journal command with `overrides[command]()`, else its default reply. */
function answer(overrides: Partial<Record<Command, () => Promise<unknown>>> = {}): void {
  invokeMock.mockImplementation(((command: string) => {
    const override = overrides[command as Command];
    if (override) return override();
    if (command in DEFAULTS) return Promise.resolve(DEFAULTS[command as Command]);
    return Promise.reject(new Error(`unexpected command ${command}`));
  }) as typeof invoke);
}

const commands = () => invokeMock.mock.calls.map(([command]) => command);

/** Watch a run settle without awaiting it, so a hang is a failed assertion, not a test timeout. */
function track<T>(run: Promise<T>): { done: boolean; value?: T; error?: unknown } {
  const state: { done: boolean; value?: T; error?: unknown } = { done: false };
  run.then(
    (value) => Object.assign(state, { done: true, value }),
    (error: unknown) => Object.assign(state, { done: true, error }),
  );
  return state;
}

/** A provenance source whose freeze payload settles after `ms` (never when `null`). */
function slowPayload(ms: number | null): void {
  registerUnsavedProvenanceSource(TAB, {
    freeze: () => ({
      touched: false, capture: { view: "v", session: "s", seq: "1" }, inTurn: (send) => send(),
      payload: () =>
        ms === null ? never() : new Promise<NamedPayload | null>((resolve) => setTimeout(() => resolve(null), ms)),
      recorded: () => {},
      invalidate: () => {},
    }),
    fork: () => ({ recorded: () => {}, invalidate: () => {} }),
  });
}

const timedOut = { status: "refused", refusal: { journalCode: "JOURNAL_TIMEOUT" } };

beforeEach(() => {
  resetMutationFixture();
  invokeMock.mockReset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("runJournaledMutation — the commit and the abort are bounded", () => {
  it("a commit acknowledgement that never settles is applied, not durable, at the deadline: no abort, no second commit", async () => {
    const ack = deferred();
    answer({ agent_journal_commit: ack.reply });
    const run = track(runJournaledMutation(mutation()));
    await vi.advanceTimersByTimeAsync(JOURNAL_DEADLINE_MS - 1);
    expect(run.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(run.value).toEqual({ status: "applied", value: "v", durable: false });
    expect(commands()).toEqual(["agent_journal_prepare", "agent_journal_commit"]);
    // The pre-write basis (no parent, no baseline), as a refused commit leaves it.
    expect(journalBasis(TAB, KEY)).toBeNull();

    // A late acknowledgement is ignored.
    await vi.advanceTimersByTimeAsync(9000 - JOURNAL_DEADLINE_MS);
    ack.resolve(COMMITTED);
    await vi.advanceTimersByTimeAsync(0);
    expect(commands()).toEqual(["agent_journal_prepare", "agent_journal_commit"]);
    expect(journalBasis(TAB, KEY)).toBeNull();
  });

  it("an abort that never settles keeps the refusal outcome at the deadline, with nothing else invoked", async () => {
    answer({ agent_journal_abort: never });
    const run = track(runJournaledMutation(mutation({ verify: () => "edited" })));
    await vi.advanceTimersByTimeAsync(JOURNAL_DEADLINE_MS - 1);
    expect(run.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(run.value).toEqual({ status: "aborted", reason: "edited" });
    expect(commands()).toEqual(["agent_journal_prepare", "agent_journal_abort"]);
  });
});

describe("runJournaledMutation — the pre-apply budget", () => {
  it("a prepare still waiting for its capture turn at the deadline refuses JOURNAL_TIMEOUT and never dispatches", async () => {
    answer();
    let openTurn: () => void = () => {};
    const turn = new Promise<void>((resolve) => (openTurn = resolve));
    registerUnsavedProvenanceSource(TAB, {
      freeze: () => ({
        touched: false, capture: { view: "v", session: "s", seq: "2" },
        inTurn: (send) => turn.then(send),
        payload: async () => null, recorded: () => {}, invalidate: () => {},
      }),
      fork: () => ({ recorded: () => {}, invalidate: () => {} }),
    });
    const run = track(runJournaledMutation(mutation()));
    await vi.advanceTimersByTimeAsync(JOURNAL_DEADLINE_MS);
    expect(run.value).toMatchObject(timedOut);
    openTurn();
    await vi.advanceTimersByTimeAsync(1);
    expect(commands()).toEqual([]);
  });

  it("readiness that never settles refuses JOURNAL_TIMEOUT with no prepare and no apply; settling late invokes nothing", async () => {
    answer();
    const release = agentJournalEpochFake.holdNextBind();
    const bound = bindJournalDocument("tab:main/held", KEY);
    const apply = vi.fn(() => ({ postimage: "after", value: "v" }));
    const run = track(runJournaledMutation(mutation({ apply })));
    await vi.advanceTimersByTimeAsync(JOURNAL_DEADLINE_MS - 1);
    expect(run.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(run.value).toMatchObject(timedOut);

    // Readiness lands 1 ms after its attempt timed out: still no invoke.
    await vi.advanceTimersByTimeAsync(1);
    release();
    await bound;
    await vi.advanceTimersByTimeAsync(JOURNAL_DEADLINE_MS);
    expect(commands()).toEqual([]);
    expect(apply).not.toHaveBeenCalled();
  });

  it("a prepare that never settles refuses JOURNAL_TIMEOUT with no apply; its late reply is aborted once, reason timedOut", async () => {
    const reply = deferred();
    answer({ agent_journal_prepare: reply.reply });
    const apply = vi.fn(() => ({ postimage: "after", value: "v" }));
    const run = track(runJournaledMutation(mutation({ apply })));
    await vi.advanceTimersByTimeAsync(JOURNAL_DEADLINE_MS);
    expect(run.value).toMatchObject(timedOut);
    expect(commands()).toEqual(["agent_journal_prepare"]);

    reply.resolve(PREPARED);
    await vi.advanceTimersByTimeAsync(0);
    expect(apply).not.toHaveBeenCalled();
    expect(commands()).toEqual(["agent_journal_prepare", "agent_journal_abort"]);
    expect(invokeMock.mock.calls[1][1]).toEqual({ txn: TXN, reason: "timedOut" });
  });

  it("a prepare refusal that lands late is dropped: nothing is aborted", async () => {
    const reply = deferred();
    answer({ agent_journal_prepare: reply.reply });
    const run = track(runJournaledMutation(mutation()));
    await vi.advanceTimersByTimeAsync(JOURNAL_DEADLINE_MS);
    expect(run.value).toMatchObject(timedOut);
    reply.reject({ code: "JOURNAL_BUSY", message: "busy" });
    await vi.advanceTimersByTimeAsync(0);
    expect(commands()).toEqual(["agent_journal_prepare"]);
  });

  it("a freeze payload that never settles refuses JOURNAL_TIMEOUT when the budget runs out, with nothing invoked", async () => {
    answer();
    slowPayload(null);
    const run = track(runJournaledMutation(mutation()));
    await vi.advanceTimersByTimeAsync(JOURNAL_PREAPPLY_BUDGET_MS - 1);
    expect(run.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(run.value).toMatchObject(timedOut);
    expect(commands()).toEqual([]);
  });

  it("after a slow freeze payload the prepare attempt gets only the remaining budget", async () => {
    answer({ agent_journal_prepare: never });
    slowPayload(6000);
    const run = track(runJournaledMutation(mutation()));
    await vi.advanceTimersByTimeAsync(JOURNAL_PREAPPLY_BUDGET_MS - 1);
    expect(run.done).toBe(false);
    expect(commands()).toEqual(["agent_journal_prepare"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(run.value).toMatchObject(timedOut);
  });
});

describe("runJournaledMutation — the worst case", () => {
  it("a slow pre-apply, then effects and a commit that never settle: applied with error, not durable, within 17 000 ms", async () => {
    answer({
      agent_journal_prepare: () => new Promise((resolve) => setTimeout(() => resolve(PREPARED), 3999)),
      agent_journal_commit: never,
    });
    slowPayload(3000);
    const run = track(runJournaledMutation(mutation({ effects: () => never() })));
    const worst = JOURNAL_PREAPPLY_BUDGET_MS + EFFECTS_DEADLINE_MS + JOURNAL_DEADLINE_MS;
    expect(worst).toBe(17_000);
    await vi.advanceTimersByTimeAsync(worst);
    expect(run.done).toBe(true);
    const out = run.value as JournaledOutcome<string>;
    expect(out).toMatchObject({ status: "appliedWithError", durable: false });
    expect(commands()).toEqual(["agent_journal_prepare", "agent_journal_commit"]);
  });
});
