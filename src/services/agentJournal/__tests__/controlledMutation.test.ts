// @vitest-environment node
// WI-AL1.3 — the controlled-mutation runner: prepare → re-verify → apply → commit. A re-verify failure (edited, closed, ime composition, selection) appends aborted and nothing is applied; apply runs synchronously after re-verify with no await between; a commit failure is applied with durable false, never an error; a failed aborted append still refuses (the reservation is kept, retries drain it); prepare refusals (JOURNAL_BUSY, STALE_PARENT, JOURNAL_DEGRADED) apply nothing; a key whose bind failed is refused before any prepare until a bind there lands
import { describe, it, expect, vi, beforeEach } from "vitest";
import { stubProvenancePayload } from "@/test/provenancePayloadFixture";

// The journal client is the shared in-memory fake (`src/test/globalTestHooks.ts`).
import { agentJournalFake as fake } from "@/test/agentJournalFake";
import { TEST_ATTRIBUTION } from "@/test/mcpAttributionFixture";
import { journalActorFor } from "../journalActor";
import { runControlledWrite, type ControlledWrite } from "../controlledMutation";
import type { AbortReason } from "../journalClient";
import { agentJournalEpochFake } from "@/test/agentJournalEpochFake";
import { bindJournalDocument, noteJournalDocument } from "../documentBinding";

const actor = journalActorFor(TEST_ATTRIBUTION);

function write(overrides: Partial<ControlledWrite<string>> = {}): ControlledWrite<string> & { applied: string[] } {
  const applied: string[] = [];
  return {
    applied,
    prepare: { docKey: "path:/a.md", parent: null, preimage: "", actor, tool: "document.write", baselineProvenance: null, baselineTouched: false },
    verify: () => null,
    apply: () => {
      applied.push("new text");
      return { postimage: "new text", value: "ok" };
    },
    recover: () => (applied.length > 0 ? "new text" : ""),
    ...overrides,
  };
}

beforeEach(() => fake.reset());

describe("runControlledWrite", () => {
  it("prepares, applies and commits durably", async () => {
    const w = write();
    const out = await runControlledWrite(w);
    expect(out).toMatchObject({ status: "applied", value: "ok", durable: true });
    expect(w.applied).toEqual(["new text"]);
    expect(fake.log.map((e) => e.op)).toEqual(["prepare", "commit"]);
    expect(fake.doc("path:/a.md").text).toBe("new text");
  });

  it.each<AbortReason>(["edited", "closed", "composing", "selection"])(
    "a re-verify failure (%s) appends aborted and applies nothing",
    async (reason) => {
      const w = write({ verify: () => reason });
      const out = await runControlledWrite(w);
      expect(out).toEqual({ status: "aborted", reason, durable: true, basis: null });
      expect(w.applied).toEqual([]);
      expect(fake.log.map((e) => e.op)).toEqual(["prepare", "abort"]);
      expect(fake.log[1].detail).toBe(reason);
      expect(fake.doc("path:/a.md").reservedBy).toBeNull();
    },
  );

  it("an aborted write reports the baseline its prepare recorded as the tab's new basis", async () => {
    const first = await runControlledWrite(write());
    expect(first.status).toBe("applied");
    const parent = first.status === "applied" ? first.revision : null;
    const out = await runControlledWrite(
      write({ prepare: { ...write().prepare, parent, preimage: "typed by the user" }, verify: () => "edited" }),
    );
    const baseline = fake.doc("path:/a.md").head;
    expect(baseline).not.toBe(parent);
    expect(out).toEqual({ status: "aborted", reason: "edited", durable: true, basis: baseline });
    const retry = await runControlledWrite(
      write({ prepare: { ...write().prepare, parent: baseline, preimage: "typed by the user" } }),
    );
    expect(retry.status).toBe("applied");
  });

  it("an aborted write with no baseline keeps the parent it stated as its basis", async () => {
    const first = await runControlledWrite(write());
    const parent = first.status === "applied" ? first.revision : null;
    const out = await runControlledWrite(
      write({ prepare: { ...write().prepare, parent, preimage: "new text" }, verify: () => "selection" }),
    );
    expect(out).toMatchObject({ status: "aborted", basis: parent });
  });

  it("an editor that refuses the apply is aborted as applyRefused", async () => {
    const out = await runControlledWrite(write({ apply: () => ({ refused: "applyRefused" }) }));
    expect(out).toMatchObject({ status: "aborted", reason: "applyRefused" });
    expect(fake.log.map((e) => e.op)).toEqual(["prepare", "abort"]);
  });

  it("runs apply synchronously after re-verify: no microtask can run between them", async () => {
    let interleaved = false;
    const w = write({
      verify: () => {
        void Promise.resolve().then(() => {
          interleaved = true;
        });
        return null;
      },
      apply: () => {
        expect(interleaved).toBe(false);
        return { postimage: "x", value: "ok" };
      },
    });
    await runControlledWrite(w);
    expect(interleaved).toBe(true);
  });

  it("re-verifies only after the prepare is acknowledged", async () => {
    fake.holdNextPrepare();
    const verify = vi.fn(() => null);
    const pending = runControlledWrite(write({ verify }));
    await Promise.resolve();
    expect(verify).not.toHaveBeenCalled();
    fake.release();
    await pending;
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it("a commit whose append fails is applied with durable false, not an error", async () => {
    fake.failNextCommits();
    const w = write();
    const out = await runControlledWrite(w);
    expect(out).toMatchObject({ status: "applied", durable: false });
    expect(w.applied).toEqual(["new text"]);
  });

  it("a commit the journal rejects outright is still applied, with durable false", async () => {
    fake.commitControlledWrite.mockRejectedValueOnce(new Error("ipc closed"));
    const out = await runControlledWrite(write());
    expect(out).toMatchObject({ status: "applied", durable: false, basis: null });
  });

  it("a committed write reports its own revision as the tab's new basis", async () => {
    const out = await runControlledWrite(write());
    expect(out.status === "applied" && out.basis).toBe(out.status === "applied" ? out.revision : "unreachable");
  });

  it("a commit the journal refuses ends uncommitted: applied, not durable, basis stays the pre-write head", async () => {
    const first = await runControlledWrite(write());
    const parent = first.status === "applied" ? first.revision : null;
    fake.refuseNextCommits();
    const w = write({ prepare: { ...write().prepare, parent, preimage: "new text" } });
    const out = await runControlledWrite(w);
    expect(out).toMatchObject({ status: "applied", durable: false, basis: parent });
    expect(w.applied).toEqual(["new text"]);
    expect(fake.doc("path:/a.md").reservedBy).toBeNull();
    const next = await runControlledWrite(
      write({ prepare: { ...write().prepare, parent: out.status === "applied" ? out.basis : null, preimage: "new text" } }),
    );
    expect(next.status).toBe("applied");
  });

  it("the degraded queue refuses the next controlled write until it drains", async () => {
    fake.failNextCommits();
    await runControlledWrite(write());
    const refused = await runControlledWrite(write({ prepare: { ...write().prepare, preimage: "new text" } }));
    expect(refused).toMatchObject({ status: "refused", refusal: { journalCode: "JOURNAL_DEGRADED" } });
    fake.drain();
    const again = await runControlledWrite(write({ prepare: { ...write().prepare, preimage: "new text" } }));
    expect(again.status).toBe("applied");
  });

  it("a failed aborted append still refuses, keeps the reservation, and a retry releases it", async () => {
    fake.failNextAborts();
    const out = await runControlledWrite(write({ verify: () => "edited" }));
    expect(out).toEqual({ status: "aborted", reason: "edited", durable: false, basis: null });
    expect(fake.doc("path:/a.md").reservedBy).not.toBeNull();
    const blocked = await runControlledWrite(write());
    expect(blocked).toMatchObject({ status: "refused", refusal: { journalCode: "JOURNAL_DEGRADED" } });
    fake.drain();
    expect(fake.doc("path:/a.md").reservedBy).toBeNull();
    expect((await runControlledWrite(write())).status).toBe("applied");
  });

  it("an abort that throws is still an aborted refusal (durable false)", async () => {
    fake.abortControlledWrite.mockRejectedValueOnce(new Error("ipc closed"));
    const out = await runControlledWrite(write({ verify: () => "closed" }));
    expect(out).toEqual({ status: "aborted", reason: "closed", durable: false, basis: null });
  });

  it("two windows preparing one document: exactly one is applied, the other is JOURNAL_BUSY", async () => {
    fake.holdNextPrepare();
    const a = write();
    const b = write();
    const first = runControlledWrite(a);
    await Promise.resolve();
    const second = await runControlledWrite(b);
    fake.release();
    expect((await first).status).toBe("applied");
    expect(second).toMatchObject({ status: "refused", refusal: { journalCode: "JOURNAL_BUSY" } });
    expect(b.applied).toEqual([]);
  });

  it("a stale parent is refused with the current head and applies nothing", async () => {
    await runControlledWrite(write());
    const stale = write({ prepare: { ...write().prepare, parent: "rev-old", preimage: "new text" } });
    const out = await runControlledWrite(stale);
    expect(out).toMatchObject({ status: "refused", refusal: { journalCode: "STALE_PARENT" } });
    expect(out.status === "refused" && out.refusal.head).toBe(fake.doc("path:/a.md").head);
    expect(stale.applied).toEqual([]);
  });

  it("a verify that throws aborts the transaction and carries the error", async () => {
    const boom = new Error("verify crashed");
    const out = await runControlledWrite(
      write({
        verify: () => {
          throw boom;
        },
      }),
    );
    expect(out).toEqual({ status: "aborted", reason: "applyRefused", durable: true, basis: null, thrown: { error: boom } });
    expect(fake.log.map((e) => e.op)).toEqual(["prepare", "abort"]);
    expect(fake.doc("path:/a.md").reservedBy).toBeNull();
  });

  it("an apply that throws after mutating commits the recovered postimage: applied with error, never aborted", async () => {
    const boom = new Error("flush crashed");
    let doc = "";
    const out = await runControlledWrite(
      write({
        apply: () => {
          doc = "half written";
          throw boom;
        },
        recover: () => doc,
      }),
    );
    expect(out).toMatchObject({ status: "appliedWithError", error: boom, postimage: "half written", durable: true });
    expect(out.status === "appliedWithError" && out.basis).toBe(out.status === "appliedWithError" ? out.revision : "unreachable");
    expect(fake.log.map((e) => e.op)).toEqual(["prepare", "commit"]);
    expect(fake.log[1].detail).toBe("half written");
    expect(fake.doc("path:/a.md").text).toBe("half written");
    expect(fake.doc("path:/a.md").reservedBy).toBeNull();
  });

  it("an applied-with-error write whose commit fails is not durable and keeps the pre-write basis", async () => {
    fake.commitControlledWrite.mockRejectedValueOnce(new Error("ipc closed"));
    const out = await runControlledWrite(
      write({
        apply: () => {
          throw new Error("flush crashed");
        },
        recover: () => "half written",
      }),
    );
    expect(out).toMatchObject({ status: "appliedWithError", durable: false, basis: null, postimage: "half written" });
  });

  it("an apply that throws with the document read back unchanged aborts and carries the error", async () => {
    const boom = new Error("dispatch refused");
    const out = await runControlledWrite(
      write({
        prepare: { ...write().prepare, preimage: "测试 unchanged" },
        apply: () => {
          throw boom;
        },
        recover: () => "测试 unchanged",
      }),
    );
    expect(out).toMatchObject({ status: "aborted", reason: "applyRefused", thrown: { error: boom } });
    expect(fake.log.map((e) => e.op)).toEqual(["prepare", "abort"]);
    expect(fake.doc("path:/a.md").reservedBy).toBeNull();
  });

  it.each([
    ["a verify that throws", "verify"],
    ["an apply that throws and reads back unchanged", "apply"],
  ] as const)("%s after the prepare recorded a baseline aborts with that baseline as the basis", async (_label, which) => {
    const first = await runControlledWrite(write());
    const parent = first.status === "applied" ? first.revision : null;
    const boom = new Error("crashed");
    const crash = (): never => {
      throw boom;
    };
    const out = await runControlledWrite(
      write({
        prepare: { ...write().prepare, parent, preimage: "typed 用户" },
        ...(which === "verify" ? { verify: crash } : { apply: crash, recover: () => "typed 用户" }),
      }),
    );
    const baseline = fake.doc("path:/a.md").head;
    expect(baseline).not.toBe(parent);
    expect(out).toEqual({ status: "aborted", reason: "applyRefused", durable: true, basis: baseline, thrown: { error: boom } });
    const retry = await runControlledWrite(write({ prepare: { ...write().prepare, parent: baseline, preimage: "typed 用户" } }));
    expect(retry.status).toBe("applied");
  });

  it("an apply that throws and cannot be read back keeps the transaction open for recovery, never aborted", async () => {
    const boom = new Error("flush crashed");
    const out = await runControlledWrite(
      write({
        apply: () => {
          throw boom;
        },
        recover: () => {
          throw new Error("tab gone");
        },
      }),
    );
    expect(out).toMatchObject({ status: "recoveryRequired", error: boom });
    expect(out.status === "recoveryRequired" && out.txn).toBe(fake.doc("path:/a.md").reservedBy);
    expect(fake.log.map((e) => e.op)).toEqual(["prepare"]);
  });

  it("a map the journal does not certify is resent once without it: the baseline is then snapshot-only", async () => {
    const map = stubProvenancePayload();
    fake.refuseNextProvenance(2);
    const out = await runControlledWrite(write({ prepare: { ...write().prepare, preimage: "typed", baselineProvenance: map } }));
    expect(out.status).toBe("applied");
    const sent = fake.prepareControlledWrite.mock.calls.map(([input]) => input.baselineProvenance);
    expect(sent).toEqual([map, null]);
  });

  it("any other refusal is not retried", async () => {
    fake.refuseNextPrepares("JOURNAL_BUSY");
    const out = await runControlledWrite(write({ prepare: { ...write().prepare, baselineProvenance: stubProvenancePayload() } }));
    expect(out).toMatchObject({ status: "refused" });
    expect(fake.prepareControlledWrite).toHaveBeenCalledTimes(1);
  });

  it("prepares only once a running bind of the document's key has landed", async () => {
    const release = agentJournalEpochFake.holdNextBind();
    const bound = bindJournalDocument("tab:main/cm1", "path:/bound.md");
    const out = runControlledWrite(write({ prepare: { ...write().prepare, docKey: "path:/bound.md" } }));
    await new Promise((r) => setTimeout(r, 0));
    expect(fake.prepareControlledWrite).not.toHaveBeenCalled();
    release();
    await bound;
    expect(await out).toMatchObject({ status: "applied", durable: true });
  });

  it("refuses a write to a key whose bind failed without preparing, until a bind there lands", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    agentJournalEpochFake.setDocument("tab:main/cm2", "doc-cm2");
    noteJournalDocument("tab:main/cm2", "doc-cm2");
    agentJournalEpochFake.failNextBinds(1);
    await bindJournalDocument("tab:main/cm2", "path:/unbound.md");
    const w = write({ prepare: { ...write().prepare, docKey: "path:/unbound.md" } });
    const out = await runControlledWrite(w);
    expect(out).toMatchObject({ status: "refused", refusal: { journalCode: "JOURNAL_IO" } });
    expect(fake.prepareControlledWrite).not.toHaveBeenCalled();
    expect(w.applied).toEqual([]);
    await bindJournalDocument("tab:main/cm2", "path:/unbound.md");
    expect(await runControlledWrite(w)).toMatchObject({ status: "applied", durable: true });
    warn.mockRestore();
  });

  it.each([
    ["another document", { doc: "path:/other.md" }],
    ["another revision", { revision: "rev-other" }],
    ["not applied", { applied: false }],
  ])("a commit acknowledgement naming %s is not durable and keeps the pre-write basis", async (_label, patch) => {
    const real = fake.commitControlledWrite.getMockImplementation()!;
    fake.commitControlledWrite.mockImplementationOnce(async (...args) => ({ ...(await real(...args)), ...patch }));
    const out = await runControlledWrite(write());
    expect(out).toMatchObject({ status: "applied", value: "ok", durable: false, basis: null });
  });
});
