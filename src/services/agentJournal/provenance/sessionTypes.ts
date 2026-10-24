/**
 * Provenance session contracts — what a collector reports through, and what
 * a freeze or a controlled write hands back, kept apart from the session so
 * collectors and the save path depend on the shapes only.
 *
 * @coordinates-with services/agentJournal/provenance/session.ts — the implementation
 * @module services/agentJournal/provenance/sessionTypes
 */

import type { ViewCertificate } from "./certificates";
import type { ProvenancePayload } from "./payload";
import type { Section } from "./pieces";
import type { DeferredOutcome } from "./window";

export interface SessionOptions {
  cap?: number;
  maxFrozen?: number;
  warn: (...args: unknown[]) => void;
}


export interface ProvenanceCollector {
  /** One transaction that turned `before` into `after`, as CodeMirror sections. */
  edit(before: string, sections: readonly Section[], after: string): void;
  /** The text is now `after`; `materialize(baseText)` maps the change from `baseText`, run before the next edit or freeze. */
  defer(after: string, materialize: (baseText: string) => DeferredOutcome): void;
  /** Something this collector could not certify happened; break the whole window. */
  gap(origin: string): void;
  /** Nothing but this collector (its certified attach, its reports) changed the text since it last reported. */
  holds(): boolean;
  /** Stop reporting; the certificate lets this same owner attach again without a break while nothing changes. A repeat call returns the same certificate. */
  detach(): ViewCertificate;
}

export interface NamedPayload {
  basis: string;
  payload: ProvenancePayload;
}

export interface ProvenanceFreeze {
  /** A person (or a gap) changed the text in this window. */
  readonly touched: boolean;
  /** The certified map to the frozen buffer from `expected` (or the window's own basis), or `null`. */
  payload(expected: string | null): Promise<NamedPayload | null>;
  /** The journal holds the frozen buffer as `id`. Terminal; the first settlement wins. */
  recorded(id: string): void;
  /** Nothing was recorded, or not what was frozen. Terminal. */
  invalidate(): void;
}

export interface ProvenanceFork {
  recorded(id: string): void;
  invalidate(): void;
}
