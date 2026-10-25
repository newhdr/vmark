// @vitest-environment node
// WI-AL2.2b — an abandon's reply is read from the closed set of states the journal answers: fenced, aborted, abortQueued, an ended request's terminalPending, terminal or abandoned, and a revert's recorded decision (decided); any other reply is warned about as malformed
import { beforeEach, describe, expect, it, vi } from "vitest";

const { callJournal, journalWarn } = vi.hoisted(() => ({ callJournal: vi.fn(), journalWarn: vi.fn() }));
vi.mock("../journalIpc", async (importOriginal) => ({ ...(await importOriginal<object>()), callJournal }));
vi.mock("@/utils/debug", async (importOriginal) => ({ ...(await importOriginal<object>()), journalWarn }));

import { abandonRequest } from "../requestEnding";

const EXPECT = { requestId: "00000000-0000-4000-8000-000000000001", digest: "d" };
const PAIR = { pageIdentity: "p", webviewGeneration: "1" };

describe("abandonRequest", () => {
  beforeEach(() => {
    callJournal.mockReset();
    journalWarn.mockReset();
  });

  it.each(["fenced", "aborted", "abortQueued", "terminalPending", "terminal", "abandoned", "decided"])(
    "accepts the journal's %s answer",
    async (state) => {
      callJournal.mockResolvedValue({ state });
      await abandonRequest("{}", EXPECT, PAIR);
      expect(callJournal).toHaveBeenCalledWith("agent_journal_abandon", { payload: "{}" }, EXPECT);
      expect(journalWarn).not.toHaveBeenCalled();
    },
  );

  it.each([{ state: "reverted" }, { state: "" }, {}, null])("warns about a malformed reply %j", async (reply) => {
    callJournal.mockResolvedValue(reply);
    await abandonRequest("{}", EXPECT, PAIR);
    expect(journalWarn).toHaveBeenCalledWith(expect.stringContaining("malformed reply"), reply);
  });
});
