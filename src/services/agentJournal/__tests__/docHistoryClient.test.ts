// @vitest-environment node
// WI-AL1.7 — the history panel's revision list client (`agent_journal_history`): rows newest first with the full actor (the four principal states, the connection id and the untrusted session label kept apart; human, system and legacy authors), the save's initiator, kind, tool, time and parent; blocked live hunks with reason, origin and lastCertified; the document's degraded flag; a malformed reply, an unknown reason, kind or principal state is refused as JOURNAL_UNAVAILABLE, never shown as something else
// WI-AL2.1b — every live hunk as the writer persisted it (id, kind, state, target revision, base and target ranges), passed through in the journal's order and never regrouped; a malformed hunk row is refused
import { describe, it, expect, vi, beforeEach } from "vitest";

import { invoke } from "@tauri-apps/api/core";
import { listDocumentHistory } from "../docHistoryClient";
import { parseJournalActor } from "../journalActor";

const invokeMock = vi.mocked(invoke);
const R1 = "0190d3c4-0000-7000-8000-000000000001";
const R2 = "0190d3c4-0000-7000-8000-000000000002";

const mcp = {
  type: "mcp",
  principal: { state: "provider", provider: "claude" },
  connectionId: "0190d3c4-0000-7000-8000-00000000000c",
  sessionLabel: "審稿 pass 🧪",
};
const row = (over: Record<string, unknown> = {}) => ({
  revision: R2,
  seq: "18446744073709551615",
  at: 1_760_000_000_000,
  kind: "controlled",
  parent: R1,
  actor: mcp,
  initiator: mcp,
  tool: "document.write",
  restore: false,
  collected: false,
  ...over,
});
const blocked = {
  hunkId: "h:1",
  state: "pending",
  reason: "snapshotOnly",
  origin: "save:snapshot",
  lastCertified: R1,
  blockedAt: R2,
  target: R2,
};
const hunk = (over: Record<string, unknown> = {}) => ({
  hunkId: "h:2",
  kind: "change",
  state: "pending",
  target: R2,
  baseRange: { from: 2, to: 2 },
  targetRange: { from: 2, to: 3 },
  ...over,
});
const reply = (over: Record<string, unknown> = {}) => ({
  generation: "42",
  rows: [row(), row({ revision: R1, kind: "observed", parent: null, actor: { type: "human" }, initiator: { type: "human" }, tool: null })],
  truncated: false,
  hunks: [hunk()],
  blocked: [blocked],
  degraded: false,
  ...over,
});

beforeEach(() => invokeMock.mockReset());

describe("listDocumentHistory", () => {
  it("sends the document key as one JSON string and returns rows, blocked hunks and the degraded flag", async () => {
    invokeMock.mockResolvedValueOnce(reply({ degraded: true, truncated: true }));
    const h = await listDocumentHistory("path:/a.md");
    expect(invokeMock).toHaveBeenCalledWith("agent_journal_history", { payload: JSON.stringify({ docKey: "path:/a.md" }) });
    expect(h.generation).toBe("42");
    expect(h.degraded).toBe(true);
    expect(h.truncated).toBe(true);
    expect(h.rows[0]).toEqual({
      revision: R2,
      seq: "18446744073709551615",
      at: 1_760_000_000_000,
      kind: "controlled",
      parent: R1,
      actor: { ...mcp, displayName: null },
      initiator: { ...mcp, displayName: null },
      tool: "document.write",
      restore: false,
      collected: false,
    });
    expect(h.rows[1]).toMatchObject({ kind: "observed", parent: null, actor: { type: "human" }, tool: null });
    expect(h.blocked).toEqual([blocked]);
  });

  it("keeps a blocked hunk with no lastCertified location as null, never invented", async () => {
    invokeMock.mockResolvedValueOnce(reply({ blocked: [{ ...blocked, lastCertified: null, blockedAt: null }] }));
    expect((await listDocumentHistory("path:/a.md")).blocked[0]).toMatchObject({ lastCertified: null, blockedAt: null });
  });

  it("returns an empty list for a document the journal never saw", async () => {
    invokeMock.mockResolvedValueOnce({ generation: "0", rows: [], truncated: false, hunks: [], blocked: [], degraded: false });
    expect((await listDocumentHistory("tab:main/t1")).rows).toEqual([]);
  });

  it("passes every persisted hunk through in the journal's order, touching ones included, never merged", async () => {
    const hunks = [
      hunk({ hunkId: "h:a", targetRange: { from: 0, to: 1 }, baseRange: { from: 0, to: 1 } }),
      hunk({ hunkId: "h:b", targetRange: { from: 1, to: 2 }, baseRange: { from: 1, to: 2 }, kind: "largeChange", state: "conflicted" }),
      hunk({ hunkId: "h:c", target: R1, kind: "restore" }),
    ];
    invokeMock.mockResolvedValueOnce(reply({ hunks }));
    expect((await listDocumentHistory("path:/a.md")).hunks).toEqual(hunks);
  });

  it.each([
    ["not an object", []],
    ["a missing hunk list", reply({ hunks: undefined })],
    ["an unknown hunk kind", reply({ hunks: [hunk({ kind: "merged" })] })],
    ["an unknown hunk state", reply({ hunks: [hunk({ state: "maybe" })] })],
    ["a hunk with no target", reply({ hunks: [hunk({ target: "" })] })],
    ["a fractional range", reply({ hunks: [hunk({ targetRange: { from: 0.5, to: 1 } })] })],
    ["a negative range", reply({ hunks: [hunk({ baseRange: { from: -1, to: 1 } })] })],
    ["an inverted range", reply({ hunks: [hunk({ targetRange: { from: 3, to: 2 } })] })],
    ["a range with no end", reply({ hunks: [hunk({ baseRange: { from: 1 } })] })],
    ["a numeric generation", reply({ generation: 42 })],
    ["a numeric seq", reply({ rows: [row({ seq: 7 })] })],
    ["an unknown kind", reply({ rows: [row({ kind: "merged" })] })],
    ["an unknown principal state", reply({ rows: [row({ actor: { ...mcp, principal: { state: "trusted" } } })] })],
    ["a provider with no name", reply({ rows: [row({ actor: { ...mcp, principal: { state: "provider" } } })] })],
    ["an mcp actor with no connection", reply({ rows: [row({ actor: { ...mcp, connectionId: "" } })] })],
    ["an unknown break reason", reply({ blocked: [{ ...blocked, reason: "cosmicRay" }] })],
    ["an empty origin", reply({ blocked: [{ ...blocked, origin: "" }] })],
    ["a missing degraded flag", reply({ degraded: undefined })],
    ["a non-numeric time", reply({ rows: [row({ at: "now" })] })],
    ["a negative time", reply({ rows: [row({ at: -1 })] })],
    ["a fractional time", reply({ rows: [row({ at: 1.5 })] })],
    ["a time past the Date range", reply({ rows: [row({ at: 1e300 })] })],
  ])("refuses %s as JOURNAL_UNAVAILABLE", async (_label, bad) => {
    invokeMock.mockResolvedValueOnce(bad);
    await expect(listDocumentHistory("path:/a.md")).rejects.toMatchObject({ journalCode: "JOURNAL_UNAVAILABLE" });
  });

  it("passes a refusal through as a JournalRefusal", async () => {
    invokeMock.mockRejectedValueOnce({ code: "conflict", message: "no journal", detail: { journalCode: "JOURNAL_UNAVAILABLE" } });
    await expect(listDocumentHistory("path:/a.md")).rejects.toMatchObject({ journalCode: "JOURNAL_UNAVAILABLE" });
  });
});

describe("parseJournalActor", () => {
  it.each([
    [{ type: "human" }, { type: "human" }],
    [{ type: "legacy" }, { type: "legacy" }],
    [{ type: "system", reason: "autosave" }, { type: "system", reason: "autosave" }],
    [
      { type: "mcp", principal: { state: "ambiguous" }, connectionId: "c", displayName: "Claude Desktop" },
      { type: "mcp", principal: { state: "ambiguous" }, connectionId: "c", sessionLabel: null, displayName: "Claude Desktop" },
    ],
  ])("reads %j", (wire, parsed) => {
    expect(parseJournalActor(wire)).toEqual(parsed);
  });

  it.each([[null], [{}], [{ type: "system" }], [{ type: "mcp", principal: { state: "anonymous" } }], [{ type: "mcp", principal: { state: "anonymous" }, connectionId: "c", sessionLabel: 3 }]])(
    "refuses %j",
    (wire) => {
      expect(parseJournalActor(wire)).toBeUndefined();
    },
  );
});
