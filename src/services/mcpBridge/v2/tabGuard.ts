/**
 * Purpose: the guard every document-targeting bridge handler runs first —
 * bring the store up to date with the mounted editors, resolve the tab the
 * request targets or refuse `INVALID_TAB`, and check the client's revision or
 * refuse `STALE`.
 *
 * It was written out by hand in each handler (three resolvers, four revision
 * checks, four copies of `structuredError`), and the copies had drifted: two
 * handlers explained WHY a tab did not resolve, three answered every case
 * with the same sentence, and none of them flushed the editor first — so a
 * read could serve text older than the revision it was served under.
 *
 * Key decisions:
 *   - The flush is part of resolving. A handler cannot obtain a tab's content,
 *     dirty flag or revision from here without the pending keystrokes already
 *     in them (see `liveEditor.ts`).
 *   - Two scopes. `any`: an explicit `tabId` may name a tab in any window,
 *     and an absent one means the focused window's active tab. `focused`: the
 *     request acts on view state (a selection), which only the focused tab
 *     has, so a `tabId` that names another tab is refused rather than
 *     redirected.
 *   - `require*` answer the request themselves on refusal and return a falsy
 *     value, so a handler's guard is two lines and cannot forget to reply.
 *   - An empty `tabId` reads as absent, as it always has.
 *
 * @coordinates-with liveEditor.ts — the flush
 * @coordinates-with stores/documentStore/revision.ts — isCurrentRevision
 * @coordinates-with stores/tabStore.ts — tab → window resolution
 * @module services/mcpBridge/v2/tabGuard
 */
import { useTabStore } from "@/stores/tabStore";
import { useDocumentStore, useRevisionStore } from "@/stores/documentStore";
import { getCurrentWindowLabel } from "@/services/persistence/workspaceStorage";
import { isWorkflowYaml, looksLikeWorkflowPath } from "@/lib/ghaWorkflow/detection";
import { respond } from "@/services/mcpBridge/utils";
import { flushLiveEditors } from "./liveEditor";
import { v2ErrorString } from "./types";
import type { DocumentKind, V2Error } from "./types";

/** A tab a request resolved to, with its document as the store holds it now. */
export interface GuardedTab {
  tabId: string;
  filePath: string | null;
  content: string;
  dirty: boolean;
  /** The tab's revision when it was resolved. */
  revision: string;
  kind: DocumentKind;
}

/** Which tabs a request may target — see the header. */
export type TabScope = "any" | "focused";

/** Answer a request with a structured (machine-readable) error. */
export function structuredError(id: string, err: V2Error): Promise<void> {
  return respond({ id, success: false, error: v2ErrorString(err) });
}

/**
 * A document's kind, from its path and content. Exported so a write can
 * re-evaluate against INCOMING content: an empty untitled tab reads as
 * Markdown until workflow-shaped YAML is written into it.
 */
export function resolveKind(filePath: string | null, content: string): DocumentKind {
  if (looksLikeWorkflowPath(filePath ?? undefined)) return "yaml-workflow";
  if (isWorkflowYaml(content)) return "yaml-workflow";
  return "markdown";
}

const invalidTab = (message: string): V2Error => ({ error: "INVALID_TAB", message });

/** Resolve the tab a request targets, or the refusal saying why not. */
export function resolveTab(tabIdArg: string | undefined, scope: TabScope = "any"): GuardedTab | V2Error {
  flushLiveEditors();
  const tabState = useTabStore.getState();
  const focusedTabId = tabState.activeTabId[getCurrentWindowLabel()];

  let tabId: string;
  if (scope === "focused") {
    if (!focusedTabId) return invalidTab("No focused tab");
    if (tabIdArg !== undefined && tabIdArg !== focusedTabId) {
      return invalidTab("tabId is not the focused tab; a selection exists only in the focused editor");
    }
    tabId = focusedTabId;
  } else if (tabIdArg) {
    const open = Object.values(tabState.tabs).some((list) => list.some((t) => t.id === tabIdArg));
    if (!open) return invalidTab("Unknown tabId");
    tabId = tabIdArg;
  } else {
    if (!focusedTabId) return invalidTab("No focused tab");
    tabId = focusedTabId;
  }

  const doc = useDocumentStore.getState().documents[tabId];
  if (!doc) return invalidTab("No document for tab");
  return {
    tabId,
    filePath: doc.filePath,
    content: doc.content,
    dirty: doc.isDirty,
    revision: useRevisionStore.getState().getRevision(tabId),
    kind: resolveKind(doc.filePath, doc.content),
  };
}

/**
 * Resolve the request's tab, or answer `INVALID_TAB` and return `null`.
 */
export async function requireTab(
  id: string,
  tabIdArg: string | undefined,
  scope: TabScope = "any",
): Promise<GuardedTab | null> {
  const resolved = resolveTab(tabIdArg, scope);
  if ("error" in resolved) {
    await structuredError(id, resolved);
    return null;
  }
  return resolved;
}

/**
 * Check the revision the client last read against the tab's current one.
 * Returns `true` when the write may proceed; otherwise answers `STALE`, with
 * the current revision so the client can re-read, and returns `false`.
 *
 * An absent revision is allowed — the greenfield "write from scratch" path.
 */
export async function requireCurrentRevision(
  id: string,
  tabId: string,
  expectedRevision: string | undefined,
): Promise<boolean> {
  if (expectedRevision === undefined) return true;
  const revisionStore = useRevisionStore.getState();
  if (revisionStore.isCurrentRevision(tabId, expectedRevision)) return true;
  await structuredError(id, {
    error: "STALE",
    message: "Document has changed since the last read",
    current_revision: revisionStore.getRevision(tabId),
  });
  return false;
}
