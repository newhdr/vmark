// @vitest-environment node
// The capture stage of a journaled save: an answer that arrives after the deadline is still reported as timed out and commits nothing to the tab's basis, but the save queued behind it chains on what that answer actually recorded (or on nothing, for a refusal), never on the local basis; a capture whose tab closed meanwhile commits nothing either
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/utils/debug", () => ({ journalWarn: vi.fn() }));

import { agentJournalFake } from "@/test/agentJournalFake";
import { JournalRefusal } from "../journalRefusal";
import { basisStamp, journalObservedBase, journalTabLife, releaseTabJournal, resetJournalBases } from "../documentIdentity";
import { capture } from "../saveCapture";

const TAB = "tab-cap";
const KEY = "path:/cap.md";
const input = {
  docKey: KEY,
  window: "main/tab-cap@test",
  observedParent: null,
  postimage: "text",
  initiator: { type: "human" } as const,
  author: null,
  claimsRevision: null,
};
const claim = () => ({ stamp: basisStamp(TAB, KEY), life: journalTabLife(TAB) });

beforeEach(() => resetJournalBases());

describe("capture", () => {
  it("in time: commits the recorded revision and hands it on", async () => {
    const out = await capture(TAB, KEY, input, null, () => true, claim());
    expect(out.outcome.journaled).toBe("yes");
    expect(out.next).toEqual({ ref: "revision", revision: out.outcome.revision });
    expect(journalObservedBase(TAB, KEY)).toEqual(out.next);
  });

  it("a successful answer after the deadline times out but hands on what it recorded", async () => {
    let live = true;
    const real = agentJournalFake.captureSaveToJournal.getMockImplementation()!;
    agentJournalFake.captureSaveToJournal.mockImplementationOnce(async (sent) => {
      const answer = await real(sent);
      live = false; // the deadline passes while the answer is on its way
      return answer;
    });
    const out = await capture(TAB, KEY, input, null, () => live, claim());
    expect(out.outcome).toEqual({ journaled: "no", revision: null, reason: "JOURNAL_TIMEOUT" });
    expect(out.next).toEqual({ ref: "revision", revision: expect.stringMatching(/^rev-save-/) });
    expect(journalObservedBase(TAB, KEY)).toBeNull();
  });

  it("a refusal after the deadline times out and hands on no base, as a refusal in time does", async () => {
    let live = true;
    agentJournalFake.captureSaveToJournal.mockImplementationOnce(async () => {
      live = false;
      throw new JournalRefusal("INVALID_TEXT", "refused");
    });
    const out = await capture(TAB, KEY, input, null, () => live, claim());
    expect(out.outcome.reason).toBe("JOURNAL_TIMEOUT");
    expect(out.next).toBeNull();
  });

  it("a capture whose tab closed meanwhile commits nothing", async () => {
    const taken = claim();
    releaseTabJournal(TAB);
    const out = await capture(TAB, KEY, input, null, () => true, taken);
    expect(out.outcome.journaled).toBe("yes");
    expect(journalObservedBase(TAB, KEY)).toBeNull();
  });
});
