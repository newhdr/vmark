/**
 * Journal feed — keeps a history panel's view current across windows: it
 * listens for the journal's generation broadcast and re-reads the view
 * after every change, in any window.
 *
 * Key decisions:
 *   - The listener is registered before the first read: an append landing
 *     between a read and a late listener would otherwise go unseen until
 *     the next one, which may never come.
 *   - One read at a time. An event during a read schedules exactly one more
 *     read after it, so a burst costs two reads and an older reply can never
 *     land after a newer one (the reads are sequential, each started after
 *     the events it answers).
 *   - The event's payload is not trusted for content: any event, including
 *     a failed start (`generation: null`) or a health change with the same
 *     generation, only triggers a re-read.
 *   - A failed read is retried after `FEED_RETRY_MS`, doubling to
 *     `FEED_RETRY_MAX_MS`, without waiting for another append.
 *   - A listener that cannot be registered is not a read failure: `onError`
 *     reports reads only, so a good read never hides a feed that hears
 *     nothing. Until the listener registers the feed polls (at `pollMs`, or
 *     `FEED_POLL_MS` when the caller asked for none) and retries the
 *     registration with the same backoff; once it listens, events drive the
 *     reads again and the fallback polling ends.
 *   - Polling is opt-in (`pollMs`), for when live updates are not running:
 *     each successful read schedules the next one `pollMs` later. It shares
 *     the one timer with the retry, so an event's read restarts the interval
 *     instead of adding a second reader.
 *   - `stop()` drops any reply still in flight and releases the listener,
 *     even one whose registration resolves later; a registration that
 *     rejects after `stop()` is not reported.
 *
 * @coordinates-with src-tauri/src/agent_journal/generation_events.rs — the broadcast
 * @module services/agentJournal/journalFeed
 */

import { listen } from "@tauri-apps/api/event";
import { journalWarn } from "@/utils/debug";

/** The Tauri event the journal emits after appends and health changes. */
export const GENERATION_EVENT = "agent-journal:generation";
export const FEED_RETRY_MS = 1_000;
/** How often a feed re-reads while live updates are not running. */
export const FEED_POLL_MS = 2_000;
const FEED_RETRY_MAX_MS = 30_000;

export interface JournalFeed {
  stop(): void;
}

/** What the read scheduler and the listener share: set by `stop()` and by a registration. */
interface FeedState {
  stopped: boolean;
  listening: boolean;
}

interface Scheduler {
  read(): Promise<void>;
  stop(): void;
}

/**
 * One read at a time, with an event during a read scheduling exactly one
 * more; after a good read the next poll (`nextPoll`), after a failed one the
 * backed-off retry, both on the one timer.
 */
function readScheduler<T>(
  state: FeedState,
  fetch: () => Promise<T>,
  apply: (value: T) => void,
  onError: (error: unknown) => void,
  nextPoll: () => number | null,
): Scheduler {
  let reading = false;
  let again = false;
  let retryMs = FEED_RETRY_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const read = async (): Promise<void> => {
    if (state.stopped) return;
    if (reading) {
      again = true;
      return;
    }
    reading = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    try {
      const value = await fetch();
      if (!state.stopped) {
        apply(value);
        const poll = nextPoll();
        if (poll !== null) timer = setTimeout(() => void read(), poll);
      }
      retryMs = FEED_RETRY_MS;
    } catch (error) {
      if (!state.stopped) {
        onError(error);
        timer = setTimeout(() => void read(), retryMs);
        retryMs = Math.min(retryMs * 2, FEED_RETRY_MAX_MS);
      }
    } finally {
      reading = false;
    }
    if (again && !state.stopped) {
      again = false;
      await read();
    }
  };

  return {
    read,
    stop() {
      if (timer !== null) clearTimeout(timer);
    },
  };
}

/**
 * Registers the generation listener (calling `onEvent` per event), retrying
 * a failed registration with backoff. `catchUp` runs once the first attempt
 * settles either way, and again after any later registration succeeds: a
 * change may have landed unheard.
 */
function listenWithRetry(state: FeedState, onEvent: () => void, catchUp: () => void): { stop(): void } {
  let unlisten: (() => void) | null = null;
  let retryMs = FEED_RETRY_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const register = (first: boolean): void => {
    timer = null;
    listen(GENERATION_EVENT, onEvent)
      .then((fn) => {
        if (state.stopped) return fn();
        unlisten = fn;
        state.listening = true;
        if (!first) catchUp();
      })
      .catch((error: unknown) => {
        if (state.stopped) return;
        journalWarn("journal live updates unavailable, polling:", error);
        timer = setTimeout(() => register(false), retryMs);
        retryMs = Math.min(retryMs * 2, FEED_RETRY_MAX_MS);
      })
      .finally(() => {
        if (first) catchUp();
      });
  };
  register(true);

  return {
    stop() {
      if (timer !== null) clearTimeout(timer);
      unlisten?.();
      unlisten = null;
    },
  };
}

/**
 * Read with `fetch` now and after every journal change; hand each reply to
 * `apply`. With `pollMs`, also re-read that long after every read.
 */
export function startJournalFeed<T>(
  fetch: () => Promise<T>,
  apply: (value: T) => void,
  onError: (error: unknown) => void,
  pollMs: number | null = null,
): JournalFeed {
  const state: FeedState = { stopped: false, listening: false };
  /** The interval after a good read: the caller's, or a fallback while deaf. */
  const nextPoll = (): number | null => pollMs ?? (state.listening ? null : FEED_POLL_MS);
  const scheduler = readScheduler(state, fetch, apply, onError, nextPoll);
  const read = () => void scheduler.read();
  const listener = listenWithRetry(state, read, read);

  return {
    stop() {
      state.stopped = true;
      scheduler.stop();
      listener.stop();
    },
  };
}
