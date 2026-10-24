/**
 * Journal deadline — bound a journal call on the save path, so a journal
 * that never answers cannot hold a save open. Past the deadline the call
 * refuses `JOURNAL_TIMEOUT` and the save reports itself not recorded.
 *
 * Key decisions:
 *   - The clock starts when the call is made, before any of its own work,
 *     so the time charged includes what the client and the libraries it
 *     uses do (hashing with `crypto.subtle`, encoding), not only the wait
 *     for the reply.
 *   - Work that never yields cannot be preempted, so it is charged when the
 *     call settles: an answer that lands after the deadline by the wall
 *     clock is refused even when it beat the timer. That covers the
 *     library's own dispatch and continuation work — synchronous work in
 *     the call, a queued continuation, the callback that settles it — which
 *     blocks the timer as long as it blocks everything else. A stall that
 *     was not the library's is charged too: that errs late, never in time.
 *   - The call itself is not cancelled. A reply arriving late is dropped by
 *     the caller, which keeps its own chain ordered (see `saveJournal.ts`).
 *
 * @module services/agentJournal/journalDeadline
 */

import { JournalRefusal, toJournalRefusal } from "./journalRefusal";

/** How long a save-path journal call may take before it is reported not recorded. */
export const JOURNAL_DEADLINE_MS = 5000;

/** Run `call` under the deadline; rejects with a `JournalRefusal`. */
export function withJournalDeadline<T>(what: string, call: () => Promise<T>, ms = JOURNAL_DEADLINE_MS): Promise<T> {
  const timeout = () => new JournalRefusal("JOURNAL_TIMEOUT", `the agent edit journal did not answer ${what} within ${ms} ms`);
  return new Promise<T>((resolve, reject) => {
    const started = performance.now();
    const late = () => performance.now() - started > ms;
    const timer = setTimeout(() => reject(timeout()), ms);
    let running: Promise<T>;
    try {
      running = call();
    } catch (error) {
      running = Promise.reject(toJournalRefusal(error));
    }
    running.then(
      (value) => {
        clearTimeout(timer);
        if (late()) reject(timeout());
        else resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(late() ? timeout() : toJournalRefusal(error));
      },
    );
  });
}
