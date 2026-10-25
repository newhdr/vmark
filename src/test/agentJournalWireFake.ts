/**
 * Test helper — the agent edit journal's wire, answered by the in-memory
 * fake (`agentJournalFake.ts`): the transport the real IPC client, page
 * registration and request coordinator run over, so every app test exercises
 * the frozen payload, the bound replies and the request answers the Rust
 * commands send.
 *
 * Key decisions:
 *   - Registration always answers, echoing the identity sent. A prepare's
 *     payload is decoded, its identity fields checked present and stripped,
 *     and the rest handed to the fake's `prepareControlledWrite` spy; its
 *     reply is bound to the request id and the SHA-256 of the payload. A
 *     refusal is a request answer `notAdmitted` (`uncertain: false`), except
 *     an unavailable journal, which answers with no request echo, as the
 *     Rust command does when its writer is off.
 *   - Commit and abort are bound to the txn and pair they named; the page
 *     pair is not validated here. Abandon answers `fenced`.
 *   - Any other command (a restore's prepare, the history panel's reads)
 *     falls through to the global `invoke` mock; `answerPrepare` and
 *     `boundRestoreReply` build a restore prepare's answer for a test that
 *     scripts it.
 *
 * Use: the global setup mocks `@/services/agentJournal/journalTransport`
 * with `journalTransportModule()`; drive `agentJournalFake` from the test.
 *
 * @module test/agentJournalWireFake
 */

import { vi } from "vitest";
import { JournalRefusal } from "@/services/agentJournal/journalRefusal";
import type { JournalAbortReason, PrepareInput } from "@/services/agentJournal/journalClient";
import { agentJournalFake as fake } from "./agentJournalFake";

type Args = Record<string, unknown>;

const IDENTITY = ["requestId", "incarnation", "webviewGeneration", "pageIdentity"] as const;
const INCARNATION = "00000000000000000000000000000001";
let generation = 0;

const isRecord = (v: unknown): v is Args => typeof v === "object" && v !== null;

async function sha256Hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** A CommandError-shaped rejection carrying `detail`. */
const rejection = (message: string, detail: Args) => ({ code: "conflict", message, detail });

function refusalDetail(error: JournalRefusal): Args {
  return { journalCode: error.journalCode, head: error.head, field: error.field, uncertain: error.uncertain };
}

/** Decode a prepare payload: its request and the fields without the identity. */
function decodePrepare(payload: unknown): { requestId: string; fields: Args } {
  const p: unknown = typeof payload === "string" ? JSON.parse(payload) : null;
  if (!isRecord(p) || IDENTITY.some((k) => typeof p[k] !== "string")) {
    throw rejection("INVALID_REQUEST: missing identity", { journalCode: "INVALID_REQUEST", uncertain: false });
  }
  const fields: Args = { ...p };
  for (const k of IDENTITY) delete fields[k];
  return { requestId: String(p.requestId), fields };
}

/** A restore prepare's (or any prepare's) bound reply for the payload `args` carried. */
export async function boundRestoreReply(args: unknown, reply: unknown): Promise<unknown> {
  const payload = isRecord(args) ? String(args.payload) : "";
  const p: unknown = JSON.parse(payload);
  const requestId = isRecord(p) ? p.requestId : null;
  return { bind: { requestId, digest: await sha256Hex(payload) }, reply };
}

/**
 * Answer a prepare-shaped command over `run`: decode the payload `args`
 * carried, hand `run` its fields without the identity, bind the reply to the
 * request, and turn a fake refusal into the command's rejection (see the header).
 */
export async function answerPrepare(args: unknown, run: (fields: Args) => Promise<unknown>): Promise<unknown> {
  const payload = isRecord(args) ? String(args.payload) : "";
  const { requestId, fields } = decodePrepare(payload);
  const digest = await sha256Hex(payload);
  try {
    return { bind: { requestId, digest }, reply: await run(fields) };
  } catch (error) {
    if (!(error instanceof JournalRefusal)) throw error;
    if (error.journalCode === "JOURNAL_UNAVAILABLE") {
      throw rejection(error.message, { journalCode: "JOURNAL_UNAVAILABLE" });
    }
    const request = { id: requestId, digest, state: "notAdmitted" };
    throw rejection(error.message, { ...refusalDetail(error), uncertain: false, request });
  }
}

const prepare = (args: Args) =>
  answerPrepare(args, async (fields) => {
    // The fake validates the fields it reads; the wire carries them as JSON.
    const prepared = await fake.prepareControlledWrite(fields as unknown as PrepareInput);
    return { ...prepared, certified: isRecord(fields.certificate), fallbackReason: null };
  });

/** Rethrow a fake refusal as the command's rejection. */
async function plain<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof JournalRefusal) throw rejection(error.message, refusalDetail(error));
    throw error;
  }
}

const pairBind = (args: Args) => ({ txn: args.txn, pageIdentity: args.pageIdentity, webviewGeneration: args.webviewGeneration });

async function commit(args: Args): Promise<unknown> {
  const body: unknown = JSON.parse(String(args.payload));
  const { postimage, ...extras } = isRecord(body) ? body : {};
  const hasExtras = Object.keys(extras).length > 0;
  const ack = await plain(() => fake.commitControlledWrite(String(args.txn), String(postimage), hasExtras ? extras : undefined));
  return { bind: pairBind(args), reply: { ...ack, certified: false, fallbackReason: null } };
}

async function abort(args: Args): Promise<unknown> {
  // The reason is whatever the client sent; the fake records it.
  const reason = String(args.reason) as JournalAbortReason;
  const ack = await plain(() => fake.abortControlledWrite(String(args.txn), reason));
  return { bind: pairBind(args), reply: ack };
}

/** Abandons the fake answered: always `fenced`. */
export const abandonSpy = vi.fn((_payload: string) => ({ state: "fenced" }));

/** Answer one journal command over the fake. */
export async function invokeJournal(command: string, args: Args): Promise<unknown> {
  switch (command) {
    case "agent_journal_register_page": {
      generation += 1;
      const pageIdentity = args.pageIdentity;
      return { bind: { pageIdentity }, reply: { incarnation: INCARNATION, webviewGeneration: String(generation), pageIdentity } };
    }
    case "agent_journal_prepare":
      return prepare(args);
    case "agent_journal_commit":
      return commit(args);
    case "agent_journal_abort":
      return abort(args);
    case "agent_journal_abandon":
      return abandonSpy(String(args.payload));
    case "agent_journal_capture": {
      const input: unknown = JSON.parse(String(args.payload));
      return plain(() => fake.captureSaveToJournal(input as Parameters<typeof fake.captureSaveToJournal>[0]));
    }
    default: {
      // Loaded late: a static import here would load the Tauri core before a test file's own mock of it.
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<unknown>(command, args);
    }
  }
}

/** The module object for `vi.mock("@/services/agentJournal/journalTransport", …)`. */
export function journalTransportModule() {
  return { invokeJournal };
}
