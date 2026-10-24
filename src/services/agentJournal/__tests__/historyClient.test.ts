// @vitest-environment node
// WI-AL1.6 — the history panel's IPC client: a restore prepare sends one JSON string and returns the text to apply (with the overwritten buffer's baseline and the uncommitted entry it resolves); uncommitted entries are listed with their preview and discarded by document key; malformed replies and refusals become JournalRefusal
import { describe, it, expect, vi, beforeEach } from "vitest";

import { invoke } from "@tauri-apps/api/core";
import { JournalRefusal } from "../journalRefusal";
import { discardUncommitted, listUncommitted, prepareRestore, type RestorePrepareInput } from "../historyClient";

const invokeMock = vi.mocked(invoke);
const TXN = "0190d3c4-0000-7000-8000-000000000001";
const REV = "0190d3c4-0000-7000-8000-000000000002";
const DOC = "0190d3c4-0000-7000-8000-000000000003";

const input: RestorePrepareInput = {
  docKey: "path:/a.md",
  parent: REV,
  preimage: "unsaved 𝒳",
  source: { from: "uncommittedPreimage", txn: TXN },
  baselineProvenance: null,
  baselineTouched: false,
};

const prepared = { doc: DOC, txn: TXN, revision: REV, generation: "18446744073709551615", baseline: REV, text: "", resolves: TXN };

beforeEach(() => invokeMock.mockReset());

describe("prepareRestore", () => {
  it("sends one JSON string and returns the text to apply, the baseline and what it resolves", async () => {
    invokeMock.mockResolvedValueOnce(prepared);
    const p = await prepareRestore(input);
    const { payload } = invokeMock.mock.calls[0][1] as { payload: string };
    const { requestId } = JSON.parse(payload) as { requestId: string };
    expect(invokeMock).toHaveBeenCalledWith("agent_journal_restore_prepare", { payload: JSON.stringify({ ...input, requestId }) });
    expect(p).toEqual(prepared);
  });

  it("accepts an empty text to restore and no baseline", async () => {
    invokeMock.mockResolvedValueOnce({ ...prepared, baseline: null, resolves: null });
    expect(await prepareRestore(input)).toMatchObject({ text: "", baseline: null, resolves: null });
  });

  it.each([
    ["a missing text", { ...prepared, text: undefined }],
    ["a numeric generation", { ...prepared, generation: 3 }],
    ["a non-decimal generation", { ...prepared, generation: "03" }],
    ["a malformed resolves", { ...prepared, resolves: 5 }],
    ["null", null],
  ])("refuses %s as JOURNAL_UNAVAILABLE", async (_label, reply) => {
    invokeMock.mockResolvedValueOnce(reply);
    await expect(prepareRestore(input)).rejects.toMatchObject({ journalCode: "JOURNAL_UNAVAILABLE" });
  });

  it("reads a rejection as a JournalRefusal", async () => {
    invokeMock.mockRejectedValueOnce({ code: "conflict", message: "stale", detail: { journalCode: "STALE_PARENT" } });
    const err = await prepareRestore(input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JournalRefusal);
    expect((err as JournalRefusal).journalCode).toBe("STALE_PARENT");
  });
});

describe("listUncommitted", () => {
  const row = {
    txn: TXN,
    actor: { type: "mcp", principal: { state: "anonymous" }, connectionId: "c1", sessionLabel: "claude" },
    tool: "document.write",
    seq: "7",
    preview: "長".repeat(120),
    complete: false,
  };

  it("lists a document's uncommitted entries with the agent's full attribution (WI-AL1.7)", async () => {
    invokeMock.mockResolvedValueOnce([row, { ...row, txn: REV, actor: { type: "human" }, preview: "", complete: true }]);
    const rows = await listUncommitted("path:/a.md");
    expect(invokeMock).toHaveBeenCalledWith("agent_journal_uncommitted", { payload: JSON.stringify({ docKey: "path:/a.md" }) });
    expect(rows).toEqual([
      {
        txn: TXN,
        actor: { type: "mcp", principal: { state: "anonymous" }, connectionId: "c1", sessionLabel: "claude", displayName: null },
        tool: "document.write",
        seq: "7",
        preview: row.preview,
        complete: false,
      },
      { txn: REV, actor: { type: "human" }, tool: "document.write", seq: "7", preview: "", complete: true },
    ]);
  });

  it("returns an empty list for a document with none", async () => {
    invokeMock.mockResolvedValueOnce([]);
    expect(await listUncommitted("tab:main/t1")).toEqual([]);
  });

  it.each([
    ["not an array", { rows: [] }],
    ["a numeric seq", [{ ...row, seq: 7 }]],
    ["a missing txn", [{ ...row, txn: "" }]],
    ["a non-boolean complete", [{ ...row, complete: "no" }]],
    ["an unknown actor type", [{ ...row, actor: { type: "robot" } }]],
  ])("refuses %s as JOURNAL_UNAVAILABLE", async (_label, reply) => {
    invokeMock.mockResolvedValueOnce(reply);
    await expect(listUncommitted("path:/a.md")).rejects.toMatchObject({ journalCode: "JOURNAL_UNAVAILABLE" });
  });
});

describe("discardUncommitted", () => {
  it("discards by document key and transaction", async () => {
    invokeMock.mockResolvedValueOnce({ durable: true });
    expect(await discardUncommitted("path:/a.md", TXN)).toEqual({ durable: true });
    expect(invokeMock).toHaveBeenCalledWith("agent_journal_discard", { payload: JSON.stringify({ docKey: "path:/a.md", txn: TXN }) });
  });

  it("refuses a malformed reply", async () => {
    invokeMock.mockResolvedValueOnce({});
    await expect(discardUncommitted("path:/a.md", TXN)).rejects.toMatchObject({ journalCode: "JOURNAL_UNAVAILABLE" });
  });
});
