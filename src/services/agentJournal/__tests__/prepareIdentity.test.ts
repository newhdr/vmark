// @vitest-environment node
// WI-AL2.2a — a controlled prepare's request identity on the wire: each logical prepare (an agent write, a restore) mints one UUID v4 requestId and sends its payload as one JSON string with that id last; the capture id crosses verbatim; the resend without a refused baseline map is a new logical request and carries a new requestId; a prepare reply is decoded losslessly (certified and fallbackReason kept, field order preserved), and a restore reply likewise
import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("@/utils/debug", () => ({ journalWarn: vi.fn() }));

vi.unmock("@/services/agentJournal/journalClient");
import { invoke } from "@tauri-apps/api/core";
import { TEST_ATTRIBUTION } from "@/test/mcpAttributionFixture";
import { stubProvenancePayload } from "@/test/provenancePayloadFixture";
import { journalActorFor } from "../journalActor";
import { prepareControlledWrite, type PrepareInput } from "../journalClient";
import { prepareRestore, type RestorePrepareInput } from "../historyClient";
import { prepareWithBaselineRetry } from "../controlledMutation";
import type { CaptureId } from "../provenance/captureId";

const invokeMock = vi.mocked(invoke);
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TXN = "0190d3c4-0000-7000-8000-000000000001";
const REV = "0190d3c4-0000-7000-8000-000000000002";
const DOC = "0190d3c4-0000-7000-8000-000000000003";
const CAPTURE: CaptureId = { view: "main/t-1", session: "0f8e2a4c-1b3d-4e5f-8a9b-0c1d2e3f4a5b", seq: "18446744073709551615" };

const input: PrepareInput = {
  docKey: "path:/a.md",
  parent: null,
  preimage: "before 稿",
  actor: journalActorFor(TEST_ATTRIBUTION),
  tool: "document.write",
  baselineProvenance: null,
  baselineTouched: false,
};
const restoreInput: RestorePrepareInput = {
  docKey: "path:/a.md",
  parent: REV,
  preimage: "unsaved",
  source: { from: "revision", revision: REV },
  baselineProvenance: null,
  baselineTouched: false,
};

const CONTROLLED = { doc: DOC, txn: TXN, revision: REV, generation: "1", baseline: REV, certified: false, fallbackReason: "notTheParent" };
const RESTORED = { doc: DOC, txn: TXN, revision: REV, generation: "2", baseline: null, text: "原文\r\n", resolves: TXN };

/** The raw payload string of every call to `command`. */
const payloads = (command: string): string[] =>
  invokeMock.mock.calls.filter(([c]) => c === command).map(([, args]) => (args as { payload: string }).payload);
const sent = (command: string) => payloads(command).map((p) => JSON.parse(p) as Record<string, unknown>);

beforeEach(() => {
  invokeMock.mockReset();
});

describe("request identity", () => {
  it("sends the prepare as one JSON string: the input, then a fresh v4 requestId", async () => {
    invokeMock.mockResolvedValueOnce(CONTROLLED);
    await prepareControlledWrite(input);
    const [payload] = payloads("agent_journal_prepare");
    const { requestId } = JSON.parse(payload) as { requestId: string };
    expect(requestId).toMatch(UUID_V4);
    expect(payload).toBe(JSON.stringify({ ...input, requestId }));
  });

  it("mints a different requestId for each logical prepare", async () => {
    invokeMock.mockResolvedValue(CONTROLLED);
    await prepareControlledWrite(input);
    await prepareControlledWrite(input);
    const [a, b] = sent("agent_journal_prepare").map((p) => p.requestId);
    expect(a).not.toBe(b);
  });

  it("sends the capture id verbatim", async () => {
    invokeMock.mockResolvedValueOnce(CONTROLLED);
    await prepareControlledWrite({ ...input, capture: CAPTURE });
    expect(sent("agent_journal_prepare")[0]).toMatchObject({ capture: CAPTURE });
  });

  it("resends a prepare whose baseline map was refused as a new request: a new requestId, the same capture", async () => {
    invokeMock
      .mockRejectedValueOnce({ code: "invalid_input", message: "m", detail: { journalCode: "INVALID_REQUEST", field: "provenance" } })
      .mockResolvedValueOnce(CONTROLLED);
    const map = stubProvenancePayload({ epoch: "1", basis: "genesis" });
    await prepareWithBaselineRetry({ ...input, baselineProvenance: map, capture: CAPTURE }, prepareControlledWrite);
    const [first, second] = sent("agent_journal_prepare");
    expect(first).toMatchObject({ baselineProvenance: map, capture: CAPTURE });
    expect(second).toMatchObject({ baselineProvenance: null, capture: CAPTURE });
    expect(second.requestId).toMatch(UUID_V4);
    expect(second.requestId).not.toBe(first.requestId);
  });

  it("gives a restore prepare its own requestId and capture", async () => {
    invokeMock.mockResolvedValueOnce(RESTORED);
    await prepareRestore({ ...restoreInput, capture: CAPTURE });
    const [payload] = payloads("agent_journal_restore_prepare");
    const { requestId } = JSON.parse(payload) as { requestId: string };
    expect(requestId).toMatch(UUID_V4);
    expect(payload).toBe(JSON.stringify({ ...restoreInput, capture: CAPTURE, requestId }));
  });
});

describe("lossless replies", () => {
  it("keeps every field of a controlled prepare reply, in wire order", async () => {
    invokeMock.mockResolvedValueOnce(CONTROLLED);
    const p = await prepareControlledWrite(input);
    expect(JSON.stringify(p)).toBe(JSON.stringify(CONTROLLED));
  });

  it("keeps every field of a restore reply, in wire order", async () => {
    invokeMock.mockResolvedValueOnce(RESTORED);
    const p = await prepareRestore(restoreInput);
    expect(JSON.stringify(p)).toBe(JSON.stringify(RESTORED));
  });
});
