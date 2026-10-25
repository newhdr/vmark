// @vitest-environment jsdom
// WI-AL2.1c — a Source selection.set sends its exact change as a certificate with the prepare (no document, epoch or basis; its map reproduces the applied text), CJK and emoji included; a WYSIWYG set sends none with the prepare and its post-apply certificate with the commit (bounded breaks over the touched block, an untouched block mapped exactly); a WYSIWYG editor without a provenance collector, and a Source editor whose text is not the journal's preimage, send none (the commit stays a whole-document barrier)

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { EditorState as CMState } from "@codemirror/state";
import { EditorView as CMView } from "@codemirror/view";

vi.mock("@/services/mcpBridge/utils", () => ({ respond: vi.fn() }));
vi.mock("@/services/persistence/workspaceStorage", () => ({ getCurrentWindowLabel: () => "main" }));
vi.mock("@/services/agentJournal/journalTransport", () =>
  import("@/test/agentJournalWireFake").then((m) => m.journalTransportModule()),
);

import { useTabStore } from "@/stores/tabStore";
import type { DocumentTab } from "@/stores/tabStoreTypes";
import { useDocumentStore } from "@/stores/documentStore";
import { useEditorStore } from "@/stores/editorStore";
import { useUIStore } from "@/stores/uiStore";
import { handleSelectionSet } from "@/services/mcpBridge/v2/selection";
import { resetJournalBases } from "@/services/agentJournal/documentIdentity";
import { decodePayload, verifyPayloadTexts } from "@/services/agentJournal/provenance/payload";
import { agentJournalFake as fake } from "@/test/agentJournalFake";
import { TEST_WRITE_CONTEXT } from "@/test/mcpAttributionFixture";
import { createTiptapExtensions } from "@/services/assembly/createTiptapExtensions";
import { setContentWithoutHistory } from "@/components/Editor/tiptapContentLoad";
import { parseMarkdown, serializeMarkdown } from "@/utils/markdownPipeline";
import { registerWysiwygFlusher } from "@/utils/wysiwygFlush";
import { noteWysiwygFlush, wysiwygProvenanceExtension } from "@/services/agentJournal/collectors/wysiwyg/wysiwygCollector";
import { provenanceSessionFor, startProvenanceSessions } from "@/services/agentJournal/provenanceSessions";
import { mapHunk } from "@/test/wysiwygNetZeroHarness";

let view: CMView | null = null;
let editor: Editor | null = null;

function seed(text: string): void {
  const tab: DocumentTab = { kind: "document", id: "a", filePath: null, title: "a", isPinned: false, formatId: "markdown" };
  useTabStore.setState({ tabs: { main: [tab] }, activeTabId: { main: "a" }, untitledCounter: 0 });
  useDocumentStore.getState().initDocument("a", text, null);
}

function sourceView(text: string, from: number, to: number): void {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  view = new CMView({ state: CMState.create({ doc: text, selection: { anchor: from, head: to } }), parent });
  useUIStore.setState({ sourceMode: true });
  useEditorStore.getState().setActiveSourceView(view, "a");
}

/** What the last prepare sent. */
function sent(): { preimage: string; certificate?: object | null } {
  const calls = fake.prepareControlledWrite.mock.calls;
  return calls[calls.length - 1][0] as { preimage: string; certificate?: object | null };
}

beforeEach(() => {
  vi.clearAllMocks();
  fake.reset();
  resetJournalBases();
  useTabStore.setState({ tabs: {}, activeTabId: {}, untitledCounter: 0 });
  useDocumentStore.setState({ documents: {} });
});

afterEach(() => {
  useEditorStore.getState().setActiveSourceView(null);
  useEditorStore.getState().setActiveWysiwygEditor(null);
  useUIStore.setState({ sourceMode: false });
  view?.dom.parentElement?.remove();
  view?.destroy();
  view = null;
  editor?.destroy();
  editor = null;
});

describe("selection.set — certificates", () => {
  it.each([
    ["a replacement", "hello world", 6, 11, "code", "hello code"],
    ["an insertion", "hello", 5, 5, " world", "hello world"],
    ["a deletion", "hello world", 5, 11, "", "hello"],
    ["CJK and emoji", "甲乙 😀 丙", 3, 5, "😁丁", "甲乙 😁丁 丙"],
  ])("a Source set sends its exact change as a certificate (%s)", async (_label, text, from, to, content, post) => {
    seed(text);
    sourceView(text, from, to);
    await handleSelectionSet("c1", { content }, TEST_WRITE_CONTEXT);

    const { preimage, certificate } = sent();
    expect(preimage).toBe(text);
    expect(certificate).toBeTruthy();
    expect(certificate).not.toHaveProperty("document");
    expect(certificate).not.toHaveProperty("epoch");
    expect(certificate).not.toHaveProperty("basis");
    // The writer binds the ids; the map then reproduces the text the editor holds.
    const bound = { ...certificate, document: "d", epoch: "0", basis: "r" };
    await expect(verifyPayloadTexts(bound, text, post)).resolves.toBeDefined();
    expect(useDocumentStore.getState().documents.a.content).toBe(post);
  });

  it("a WYSIWYG set sends its post-apply certificate with the commit, none with the prepare", async () => {
    const text = "# Title\n\npara one\n\npara two\n";
    const opts = { preserveBlankLines: true } as const;
    seed(text);
    const stop = startProvenanceSessions();
    try {
      provenanceSessionFor("a")!.fork(text).recorded("r0");
      const element = document.createElement("div");
      document.body.appendChild(element);
      editor = new Editor({ element, extensions: [...createTiptapExtensions(), wysiwygProvenanceExtension("a")] });
      const live = editor;
      expect(setContentWithoutHistory(live, parseMarkdown(live.schema, text, opts), () => true, text)).toBe("applied");
      registerWysiwygFlusher("a", () => {
        const markdown = serializeMarkdown(live.schema, live.state.doc, opts);
        noteWysiwygFlush(live, markdown, opts);
        useDocumentStore.getState().setEditorContent("a", markdown);
      });
      let at = -1;
      live.state.doc.descendants((n, pos) => {
        if (at < 0 && n.isText && n.text === "para two") at = pos + 5;
      });
      live.commands.setTextSelection({ from: at, to: at + 3 });
      useEditorStore.getState().setActiveWysiwygEditor(live, "a");
      await handleSelectionSet("c4", { content: "2" }, TEST_WRITE_CONTEXT);

      expect(sent().certificate ?? null).toBeNull();
      const post = useDocumentStore.getState().documents.a.content;
      expect(post).toBe("# Title\n\npara one\n\npara 2\n");
      const [, committed, extras] = fake.commitControlledWrite.mock.calls[0] as [string, string, { certificate?: object }];
      expect(committed).toBe(post);
      expect(extras?.certificate).toBeTruthy();
      const bound = { ...extras.certificate, document: "d", epoch: "0", basis: "r" };
      await expect(verifyPayloadTexts(bound, text, post)).resolves.toBeDefined();
      const p = decodePayload(bound);
      expect(p.whole).toBeNull();
      expect(mapHunk(p, text, "para two").block).not.toBeNull();
      expect(mapHunk(p, text, "itl").block).toBeNull();
    } finally {
      registerWysiwygFlusher("a", null);
      stop();
    }
  });

  it("a WYSIWYG editor without a provenance collector sends no certificate", async () => {
    seed("Hello world");
    editor = new Editor({ extensions: [StarterKit], content: "<p>Hello world</p>" });
    editor.commands.setTextSelection({ from: 7, to: 12 });
    useEditorStore.getState().setActiveWysiwygEditor(editor, "a");
    await handleSelectionSet("c2", { content: "there" }, TEST_WRITE_CONTEXT);

    expect(fake.prepareControlledWrite).toHaveBeenCalledTimes(1);
    expect(sent().certificate ?? null).toBeNull();
    const extras = fake.commitControlledWrite.mock.calls[0]?.[2] as { certificate?: object } | undefined;
    expect(extras?.certificate ?? null).toBeNull();
  });

  it("a Source editor whose text is not the journal's preimage sends no certificate", async () => {
    // A store that does not hold the editor's text: offsets in the editor
    // would not name positions of the preimage.
    seed("hello world");
    sourceView("hello world", 6, 11);
    useDocumentStore.getState().setEditorContent("a", "other text");
    await handleSelectionSet("c3", { content: "code" }, TEST_WRITE_CONTEXT);

    expect(fake.prepareControlledWrite).toHaveBeenCalledTimes(1);
    expect(sent().certificate ?? null).toBeNull();
  });
});
