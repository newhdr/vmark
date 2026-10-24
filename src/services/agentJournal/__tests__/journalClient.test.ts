// @vitest-environment node
// WI-AL1.3 — the IPC client for the controlled-mutation protocol: payloads cross as JSON strings so a lone surrogate reaches Rust escaped (INVALID_TEXT, never replaced), generations are decimal strings, malformed replies and refusals become JournalRefusal, abort reasons are the closed set; a selection certificate crosses verbatim, the certified flag and fallback reason of each reply are checked, and a fallback is logged (WI-AL2.1c)
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
vi.mock("@/utils/debug", () => ({ journalWarn: vi.fn() }));
import { stubProvenancePayload } from "@/test/provenancePayloadFixture";

vi.unmock("@/services/agentJournal/journalClient");
import { invoke } from "@tauri-apps/api/core";
import { TEST_ATTRIBUTION } from "@/test/mcpAttributionFixture";
import { journalActorFor } from "../journalActor";
import { JournalRefusal } from "../journalRefusal";
import { journalWarn } from "@/utils/debug";
import { abortControlledWrite, commitControlledWrite, prepareControlledWrite } from "../journalClient";
import { selectionCertificate, type SelectionCertificate } from "../selectionCertificate";

const invokeMock = vi.mocked(invoke);
const TXN = "0190d3c4-0000-7000-8000-000000000001";
const REV = "0190d3c4-0000-7000-8000-000000000002";
const DOC = "0190d3c4-0000-7000-8000-000000000003";

const input = {
  docKey: "path:/a.md",
  parent: null,
  preimage: "before",
  actor: journalActorFor(TEST_ATTRIBUTION),
  tool: "document.write",
  baselineProvenance: null,
  baselineTouched: false,
};

beforeEach(() => {
  invokeMock.mockReset();
  vi.mocked(journalWarn).mockReset();
});

const PREPARED = { doc: DOC, txn: TXN, revision: REV, generation: "1", baseline: null };
let CERT: SelectionCertificate;
beforeAll(async () => {
  CERT = await selectionCertificate("abc", { from: 1, to: 2, insert: "x" });
});

describe("selection certificates", () => {
  it("sends a prepare's certificate verbatim", async () => {
    invokeMock.mockResolvedValueOnce({ ...PREPARED, certified: true, fallbackReason: null });
    await prepareControlledWrite({ ...input, certificate: CERT });
    const { payload } = invokeMock.mock.calls[0][1] as { payload: string };
    expect(JSON.parse(payload)).toMatchObject({ certificate: CERT });
    expect(journalWarn).not.toHaveBeenCalled();
  });

  it("warns when the prepare admitted the write uncertified", async () => {
    invokeMock.mockResolvedValueOnce({ ...PREPARED, certified: false, fallbackReason: "notTheParent" });
    await prepareControlledWrite({ ...input, certificate: CERT });
    expect(journalWarn).toHaveBeenCalledWith(expect.stringContaining("notTheParent"));
  });

  it("warns when the commit fell back to a barrier, and still answers applied and durable", async () => {
    invokeMock.mockResolvedValueOnce({ doc: DOC, revision: REV, applied: true, durable: true, certified: false, fallbackReason: "notThePostimage" });
    expect(await commitControlledWrite(TXN, "after")).toEqual({ doc: DOC, revision: REV, applied: true, durable: true });
    expect(journalWarn).toHaveBeenCalledWith(expect.stringContaining("notThePostimage"));
  });

  it.each([
    ["a missing certified flag", { ...PREPARED, fallbackReason: null }],
    ["an unknown fallback reason", { ...PREPARED, certified: false, fallbackReason: "becauseOfReasons" }],
    ["a certified prepare with a fallback reason", { ...PREPARED, certified: true, fallbackReason: "wholeBreak" }],
  ])("refuses a prepare reply with %s", async (_label, reply) => {
    invokeMock.mockResolvedValueOnce(reply);
    await expect(prepareControlledWrite(input)).rejects.toMatchObject({ journalCode: "JOURNAL_UNAVAILABLE" });
  });

  it("refuses a commit reply without its certified flag", async () => {
    invokeMock.mockResolvedValueOnce({ doc: DOC, revision: REV, applied: true, durable: true, fallbackReason: null });
    await expect(commitControlledWrite(TXN, "x")).rejects.toMatchObject({ journalCode: "JOURNAL_UNAVAILABLE" });
  });
});

describe("prepareControlledWrite", () => {
  it("sends the request as one JSON string and returns the prepared transaction", async () => {
    invokeMock.mockResolvedValueOnce({ doc: DOC, txn: TXN, revision: REV, generation: "18446744073709551615", baseline: null, certified: false, fallbackReason: null });
    const p = await prepareControlledWrite(input);
    expect(p.generation).toBe("18446744073709551615");
    expect(invokeMock).toHaveBeenCalledWith("agent_journal_prepare", { payload: JSON.stringify(input) });
  });

  it("sends a flushed provenance map verbatim as baselineProvenance", async () => {
    invokeMock.mockResolvedValueOnce({ doc: DOC, txn: TXN, revision: REV, generation: "1", baseline: REV, certified: false, fallbackReason: null });
    const map = stubProvenancePayload({ epoch: "1", basis: "genesis" });
    await prepareControlledWrite({ ...input, baselineProvenance: map });
    const { payload } = invokeMock.mock.calls[0][1] as { payload: string };
    expect(JSON.parse(payload)).toMatchObject({ baselineProvenance: map });
  });

  it("sends whether a person touched the buffer as baselineTouched", async () => {
    invokeMock.mockResolvedValueOnce({ doc: DOC, txn: TXN, revision: REV, generation: "1", baseline: REV, certified: false, fallbackReason: null });
    await prepareControlledWrite({ ...input, baselineTouched: true });
    const { payload } = invokeMock.mock.calls[0][1] as { payload: string };
    expect(JSON.parse(payload)).toMatchObject({ baselineTouched: true });
  });

  it("escapes a lone surrogate instead of replacing it, so Rust can refuse it", async () => {
    invokeMock.mockResolvedValueOnce({ doc: DOC, txn: TXN, revision: REV, generation: "1", baseline: null, certified: false, fallbackReason: null });
    await prepareControlledWrite({ ...input, preimage: "a\uD800" });
    const { payload } = invokeMock.mock.calls[0][1] as { payload: string };
    expect(payload).toContain("a\\ud800");
  });

  it("surfaces a typed refusal as JournalRefusal", async () => {
    invokeMock.mockRejectedValueOnce({ code: "conflict", message: "m", detail: { journalCode: "JOURNAL_BUSY" } });
    await expect(prepareControlledWrite(input)).rejects.toMatchObject({ journalCode: "JOURNAL_BUSY" });
  });

  it.each([
    ["undefined", undefined],
    ["a numeric generation", { doc: DOC, txn: TXN, revision: REV, generation: 7, baseline: null, certified: false, fallbackReason: null }],
    ["a non-canonical generation", { doc: DOC, txn: TXN, revision: REV, generation: "07", baseline: null, certified: false, fallbackReason: null }],
    ["a missing txn", { doc: DOC, revision: REV, generation: "1", baseline: null, certified: false, fallbackReason: null }],
  ])("refuses a malformed reply (%s) as JOURNAL_UNAVAILABLE", async (_label, reply) => {
    invokeMock.mockResolvedValueOnce(reply);
    const err = await prepareControlledWrite(input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JournalRefusal);
    expect((err as JournalRefusal).journalCode).toBe("JOURNAL_UNAVAILABLE");
  });
});

describe("commitControlledWrite", () => {
  it("sends the postimage and returns applied + durable", async () => {
    invokeMock.mockResolvedValueOnce({ doc: DOC, revision: REV, applied: true, durable: false, certified: false, fallbackReason: null });
    const c = await commitControlledWrite(TXN, "after");
    expect(c).toEqual({ doc: DOC, revision: REV, applied: true, durable: false });
    expect(invokeMock).toHaveBeenCalledWith("agent_journal_commit", {
      txn: TXN,
      payload: JSON.stringify({ postimage: "after" }),
    });
  });

  it("carries commit extras beside the postimage; an extra never replaces the postimage", async () => {
    invokeMock.mockResolvedValueOnce({ doc: DOC, revision: REV, applied: true, durable: true, certified: false, fallbackReason: null });
    await commitControlledWrite(TXN, "after", { review: { hunks: [] }, postimage: "forged" });
    expect(invokeMock).toHaveBeenCalledWith("agent_journal_commit", {
      txn: TXN,
      payload: JSON.stringify({ review: { hunks: [] }, postimage: "after" }),
    });
  });

  it("rejects with a JournalRefusal when the commit is refused", async () => {
    invokeMock.mockRejectedValueOnce({ code: "conflict", message: "m", detail: { journalCode: "JOURNAL_DEGRADED" } });
    await expect(commitControlledWrite(TXN, "x")).rejects.toMatchObject({ journalCode: "JOURNAL_DEGRADED" });
  });
});

describe("abortControlledWrite", () => {
  it.each(["edited", "closed", "composing", "selection", "applyRefused"] as const)(
    "records the %s reason",
    async (reason) => {
      invokeMock.mockResolvedValueOnce({ durable: true });
      expect(await abortControlledWrite(TXN, reason)).toEqual({ durable: true });
      expect(invokeMock).toHaveBeenCalledWith("agent_journal_abort", { txn: TXN, reason });
    },
  );

  it("refuses a malformed abort reply", async () => {
    invokeMock.mockResolvedValueOnce({ durable: "yes" });
    await expect(abortControlledWrite(TXN, "closed")).rejects.toBeInstanceOf(JournalRefusal);
  });
});
