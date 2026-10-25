/**
 * Epoch lease — a provenance session's hold on its document's editing
 * epoch: armed on demand, closed when the session has nothing left to
 * certify, every arm and close run one after another on a single chain.
 *
 * Key decisions:
 *   - One arm in flight at a time; every caller waiting meanwhile gets the
 *     same answer. A failed arm answers `null` (the window is then
 *     snapshot-only) and the next demand tries again.
 *   - An arm that answers after `dispose`, or whose `onArmed` handshake
 *     fails, is closed at once, so no epoch stays armed that no session
 *     holds.
 *   - `onArmed` runs before the epoch is handed out (the session's basis
 *     handshake); `afterArm` runs after (the session may close it again).
 *   - A known suspension (`SessionJournal.suspended`: recording on the
 *     document is suspended until its identity is rebound) is one episode:
 *     the failed arm warns once, and later demands answer `null` without
 *     arming or warning until the suspension lifts; the next demand then
 *     arms again.
 *
 * @coordinates-with services/agentJournal/provenance/session.ts — the owner
 * @coordinates-with services/agentJournal/epochClient.ts — the IPC behind `SessionJournal`
 * @module services/agentJournal/provenance/epochLease
 */

import type { ArmedEpoch } from "../epochClient";

/** The journal calls a session makes; rejections are failures to arm or close. */
export interface SessionJournal {
  arm(): Promise<ArmedEpoch>;
  close(epoch: string): Promise<void>;
  /** Whether recording on the document is suspended now (an arm cannot succeed until that lifts). */
  suspended?(): boolean;
}

export interface LeaseHooks {
  onArmed: (armed: ArmedEpoch) => Promise<void>;
  afterArm: () => void;
  warn: (...args: unknown[]) => void;
}

export class EpochLease {
  #armed: ArmedEpoch | null = null;
  #arming: Promise<ArmedEpoch | null> | null = null;
  #chain: Promise<unknown> = Promise.resolve();
  #disposed = false;
  /** In a suspension episode whose warning was given. */
  #suspended = false;

  constructor(
    private readonly journal: SessionJournal,
    private readonly hooks: LeaseHooks,
  ) {}

  /** The armed epoch, arming it first if needed; `null` when it cannot be armed. */
  ensure(): Promise<ArmedEpoch | null> {
    if (this.#armed) return Promise.resolve(this.#armed);
    if (this.#disposed && !this.#arming) return Promise.resolve(null);
    if (this.#suspended && !this.#arming) {
      if (this.journal.suspended?.() === true) return Promise.resolve(null);
      this.#suspended = false;
    }
    this.#arming ??= this.#queue(() => this.#arm()).then((armed) => {
      this.hooks.afterArm();
      return armed;
    });
    return this.#arming;
  }

  /** An epoch is armed, or an arm is in flight. */
  get engaged(): boolean {
    return this.#armed !== null || this.#arming !== null;
  }

  /** The armed epoch, after any arm already in flight; never starts an arm. */
  async current(): Promise<ArmedEpoch | null> {
    if (this.#arming) await this.#arming;
    return this.#armed;
  }

  /** Close the armed epoch, if any. */
  release(): void {
    const armed = this.#armed;
    if (!armed) return;
    this.#armed = null;
    void this.#queue(() => this.journal.close(armed.epoch)).catch((e: unknown) => this.hooks.warn("provenance: close failed", e));
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    await this.#arming;
    this.release();
    await this.idle();
  }

  /** Resolves once every queued arm and close has finished. */
  async idle(): Promise<void> {
    let seen: Promise<unknown>;
    do {
      seen = this.#chain;
      await seen;
    } while (seen !== this.#chain);
  }

  async #arm(): Promise<ArmedEpoch | null> {
    let armed: ArmedEpoch | null = null;
    try {
      armed = await this.journal.arm();
      if (this.#disposed) {
        await this.#closeNow(armed);
        return null;
      }
      await this.hooks.onArmed(armed);
      this.#armed = armed;
      return armed;
    } catch (error) {
      // @edge-case A known suspension warns once per episode, not per edit.
      if (this.journal.suspended?.() === true) {
        if (!this.#suspended) this.hooks.warn("provenance: recording is suspended until the document's identity is rebound", error);
        this.#suspended = true;
      } else {
        this.hooks.warn("provenance: could not arm an editing epoch", error);
      }
      // A failed handshake must not leave the epoch it armed open: the
      // writer refuses the next arm of the document until it closes.
      if (armed) await this.#closeNow(armed);
      return null;
    } finally {
      this.#arming = null;
    }
  }

  #closeNow(armed: ArmedEpoch): Promise<void> {
    return this.journal.close(armed.epoch).catch((e: unknown) => this.hooks.warn("provenance: close failed", e));
  }

  #queue<T>(step: () => Promise<T>): Promise<T> {
    const run = this.#chain.then(step, step);
    this.#chain = run.catch(() => undefined);
    return run;
  }
}
