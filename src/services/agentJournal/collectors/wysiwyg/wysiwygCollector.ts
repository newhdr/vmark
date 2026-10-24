/**
 * WYSIWYG collector — reports a Tiptap editor's flushes to its tab's
 * provenance session as bounded block breaks, certified by the editor's own
 * transaction ledger.
 *
 * Pipeline: the extension gives each editor a ledger (its observer plugin)
 * → a content load writes the store's text into the editor →
 * `noteWysiwygLoaded` anchors the document there → each flush calls
 * `noteWysiwygFlush` before its store write → a deferral the session
 * materializes later (wysiwygWindow.ts).
 *
 * Key decisions:
 *   - A load is the editor's certificate: when the loaded text is the
 *     session's text, the collector attaches with a certificate the session
 *     issues to it then; otherwise it attaches uncertified (a whole break).
 *     The anchor is the ledger's boundary at the loaded state.
 *   - Every flush advances the anchor to its head; consecutive flushes the
 *     session has not materialized extend one window. A flush when the
 *     collector does not hold the session's text (another surface or an
 *     unannounced write changed it) breaks the whole document
 *     (`wysiwyg:no-certificate`).
 *   - Whether a flush reports is decided by the ledger, never by Markdown
 *     equality: a flush whose chain holds any step reports through the same
 *     deferral even when the text is unchanged (a delete-and-retype, a mark
 *     toggled back), so the touched blocks stay bounded breaks and the epoch
 *     is armed; an unobserved, capped or uncertified chain at equal text is a
 *     whole break. Only a chain proven to hold no step reports nothing.
 *   - A ledger gap after the anchor (the plugin set changed while live, a
 *     state installed behind the ledger's back) is reported at once: a loud
 *     warning and a whole-document break (`wysiwyg:unobserved-transaction`),
 *     and nothing is certified until the next flush re-anchors.
 *   - A replaced session (save-as) is re-attached uncertified.
 *   - A report that throws interrupts the window the same way.
 *   - The editor's teardown detaches it (the extension's destroy hook).
 *
 * @coordinates-with services/agentJournal/collectors/wysiwyg/txnLedger.ts — the observer
 * @coordinates-with services/agentJournal/collectors/wysiwyg/wysiwygWindow.ts — what a flush claims
 * @coordinates-with services/agentJournal/provenanceSessions.ts — the tab's session
 * @coordinates-with components/Editor/tiptapContentLoad.ts — the loads
 * @coordinates-with components/Editor/useTiptapFlush.ts — the flushes
 * @module services/agentJournal/collectors/wysiwyg/wysiwygCollector
 */

import { Extension, type Editor } from "@tiptap/core";
import type { MarkdownPipelineOptions } from "@/utils/markdownPipeline/types";
import { journalWarn } from "@/utils/debug";
import type { ProvenanceCollector, ProvenanceSession } from "../../provenance/session";
import { provenanceSessionFor } from "../../provenanceSessions";
import { TxnLedger, observerPlugin, type Boundary } from "./txnLedger";
import { WYSIWYG_ORIGIN, extendWindow, materializeWindow, type PendingWindow, type Spanned } from "./wysiwygWindow";

interface Anchor {
  readonly boundary: Boundary;
  readonly spanned: Spanned;
}

class EditorProvenance {
  readonly ledger = new TxnLedger();
  readonly #owner = {};
  #bound: ProvenanceSession | null = null;
  #collector: ProvenanceCollector | null = null;
  #anchor: Anchor | null = null;
  #pending: PendingWindow | null = null;

  constructor(
    private readonly tabId: string,
    private readonly editor: Editor,
  ) {
    this.ledger.onGap = (reason) => this.interrupt(`observation interrupted (${reason})`);
  }

  loaded(markdown: string): void {
    const session = provenanceSessionFor(this.tabId);
    this.#collector?.detach();
    this.#bound = session;
    this.#pending = null;
    this.#anchor = null;
    if (!session) return void (this.#collector = null);
    const certified = session.text === markdown;
    this.#collector = session.attach(this.#owner, certified ? session.openView(this.#owner) : null, WYSIWYG_ORIGIN);
    if (certified) this.#anchor = this.#anchorHere();
  }

  flushed(markdown: string, opts: MarkdownPipelineOptions): void {
    const session = provenanceSessionFor(this.tabId);
    if (session !== this.#bound) this.#rebind(session);
    const collector = this.#collector;
    if (!session || !collector) return;
    const held = collector.holds();
    const anchor = this.#anchor;
    const state = this.editor.state;
    const step = !anchor || !held ? "no-certificate" : this.ledger.chain(anchor.boundary, state);
    // @edge-case Equal Markdown is not "nothing happened": a delete-and-retype
    // or a mark toggled back changed blocks the text no longer shows. Only a
    // chain proven to hold no step (selection-only) stays silent.
    if (markdown === session.text && typeof step !== "string" && step.ok && step.edges.length === 0) return;
    const prior = held && this.#pending && !this.#pending.ran ? this.#pending : null;
    const next = this.#anchorHere();
    const from = anchor?.spanned ?? next.spanned;
    const window = extendWindow(prior, from, step, next.spanned, markdown, opts);
    this.#anchor = next;
    this.#pending = window;
    const schema = this.editor.schema;
    collector.defer(markdown, (base) => materializeWindow(schema, window, base));
  }

  stop(): void {
    this.ledger.onGap = null;
    this.#collector?.detach();
    this.#collector = null;
    this.#bound = null;
    this.#anchor = null;
    this.#pending = null;
  }

  /** A boundary at the current state; the ledger keeps nothing before it. */
  #anchorHere(): Anchor {
    const boundary = this.ledger.boundary(this.editor.state);
    this.ledger.forget(boundary.cursor);
    return { boundary, spanned: { doc: boundary.doc, spans: null } };
  }

  #rebind(session: ProvenanceSession | null): void {
    this.#collector?.detach();
    this.#bound = session;
    this.#collector = session ? session.attach(this.#owner, null, WYSIWYG_ORIGIN) : null;
    this.#pending = null;
  }

  /** Nothing before now can be certified: a whole break, loudly; the next flush re-anchors. */
  interrupt(why: string): void {
    this.#anchor = null;
    this.#pending = null;
    if (!this.#collector) return;
    journalWarn(`wysiwyg provenance: ${why}; this window is snapshot-only`);
    this.#collector.gap(`${WYSIWYG_ORIGIN}:unobserved-transaction`);
  }
}

const registry = new WeakMap<Editor, EditorProvenance>();

/** The ledger's extension for an editor of tab `tabId`. */
export function wysiwygProvenanceExtension(tabId: string): Extension {
  return Extension.create({
    name: "journalProvenance",
    addProseMirrorPlugins() {
      const provenance = new EditorProvenance(tabId, this.editor);
      registry.set(this.editor, provenance);
      return [observerPlugin(provenance.ledger)];
    },
    onDestroy() {
      registry.get(this.editor)?.stop();
      registry.delete(this.editor);
    },
  });
}

/** A content load wrote `markdown` into `editor` (its transaction has been dispatched). */
export function noteWysiwygLoaded(editor: Editor, markdown: string): void {
  report(editor, (p) => p.loaded(markdown));
}

/** `editor` is about to write `markdown`, serialized with `opts`, to the store. */
export function noteWysiwygFlush(editor: Editor, markdown: string, opts: MarkdownPipelineOptions): void {
  report(editor, (p) => p.flushed(markdown, opts));
}

function report(editor: Editor, run: (p: EditorProvenance) => void): void {
  const provenance = registry.get(editor);
  if (!provenance) return;
  try {
    run(provenance);
  } catch (error) {
    provenance.interrupt(`a report failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
