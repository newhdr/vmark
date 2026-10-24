/**
 * Journal refusals — the typed reason a controlled write was not prepared,
 * read from the `CommandError` the journal commands reject with.
 *
 * Key decisions:
 *   - The exact token rides in `detail.journalCode`; the command error's
 *     `code` is only its class. A rejection that is not a typed journal
 *     refusal (an IPC failure, a missing command) is `JOURNAL_UNAVAILABLE`:
 *     nothing can be assumed written, so the write does not go ahead.
 *   - `head` is carried for `STALE_PARENT` so a caller can forget the stale
 *     basis it sent.
 *   - `field` names the request field a refusal is about. `provenance`
 *     means only the window's map was refused and nothing was recorded:
 *     the caller resends the same request without it.
 *   - `STALE_REQUEST` (a request that ended, was fenced, or names a stale
 *     writer or page) and `STALE_PAGE` (a commit or abort whose page
 *     registration is no longer live) are the request protocol's answers.
 *   - `JOURNAL_TIMEOUT` is never sent by the journal: the client raises
 *     it when a call on the save path outlives its deadline
 *     (`journalDeadline.ts`).
 *
 * @coordinates-with src-tauri/src/agent_journal/refusal.rs — the Rust mapping
 * @module services/agentJournal/journalRefusal
 */

import { parseCommandError } from "@/services/commands/commandError";

/** Every token a journal command can refuse with. */
const JOURNAL_CODES = [
  "JOURNAL_BUSY",
  "STALE_PARENT",
  "JOURNAL_DEGRADED",
  "STALE_REVIEW",
  "REVIEW_BACKLOG_FULL",
  "REVIEW_STATE_EXHAUSTED",
  "INVALID_REQUEST",
  "INVALID_TEXT",
  "JOURNAL_IO",
  "INVARIANT_BROKEN",
  "JOURNAL_CORRUPT",
  "JOURNAL_FUTURE_FORMAT",
  "STALE_REQUEST",
  "STALE_PAGE",
  "JOURNAL_UNAVAILABLE",
  "JOURNAL_TIMEOUT",
] as const;

export type JournalCode = (typeof JOURNAL_CODES)[number];

function isJournalCode(value: unknown): value is JournalCode {
  return typeof value === "string" && (JOURNAL_CODES as readonly string[]).includes(value);
}

/** A journal command refused; nothing was recorded for this request. */
export class JournalRefusal extends Error {
  readonly journalCode: JournalCode;
  /** The current head, for `STALE_PARENT`; `null` otherwise or at genesis. */
  readonly head: string | null;
  /** The request field refused (`provenance`), or `null` for the whole request. */
  readonly field: string | null;

  constructor(journalCode: JournalCode, message: string, head: string | null = null, field: string | null = null) {
    super(message);
    this.name = "JournalRefusal";
    this.journalCode = journalCode;
    this.head = head;
    this.field = field;
  }
}

/** Read any `invoke` rejection as a journal refusal. */
export function toJournalRefusal(error: unknown): JournalRefusal {
  if (error instanceof JournalRefusal) return error;
  const parsed = parseCommandError(error);
  const code = parsed?.detail?.journalCode;
  if (parsed && isJournalCode(code)) {
    const head = parsed.detail?.head;
    const field = parsed.detail?.field;
    return new JournalRefusal(
      code,
      parsed.message,
      typeof head === "string" ? head : null,
      typeof field === "string" ? field : null,
    );
  }
  const message = parsed?.message ?? (error instanceof Error ? error.message : String(error));
  return new JournalRefusal("JOURNAL_UNAVAILABLE", `the agent edit journal did not answer: ${message}`);
}
