/**
 * Comment drafts — keeps the comment panel's unsent text (a new comment
 * with its selection, a reply, which thread is being replied to) across the
 * history popover closing and reopening, so Escape or an outside click
 * never throws a draft away.
 *
 * Key decisions:
 *   - The popover unmounts its panels when it closes, so a draft cannot
 *     live in component state; it lives here, keyed by what it belongs to
 *     (the tab, the document, the thread), and a remount reads it back.
 *   - This module sits in the comments chunk, loaded on demand
 *     (`lazyHistoryParts.tsx`), so the status bar's cold-start bundle does
 *     not grow; the history button keeps closing as before.
 *   - Setting a draft back to its empty value forgets it, so a sent or
 *     cancelled draft leaves nothing behind.
 *   - A key change (another tab focused) reads that key's own draft: one
 *     tab's selection is never offered on another tab.
 *
 * Known limitations: a draft of a tab that is closed without cancelling it
 * stays in memory until the window reloads; it is a few strings.
 *
 * @coordinates-with components/Comments/AddComment.tsx — the new comment
 * @coordinates-with components/Comments/CommentsPanel.tsx — the thread being replied to
 * @coordinates-with components/Comments/CommentThreadView.tsx — the reply
 * @module components/Comments/commentDrafts
 */

import { useCallback, useState } from "react";

const kept = new Map<string, unknown>();

/**
 * State under `key` that outlives the component: read back on remount,
 * forgotten when set to `empty` (compared with `===`).
 */
export function useCommentDraft<T>(key: string, empty: T): [T, (value: T) => void] {
  const read = (k: string): T => (kept.has(k) ? (kept.get(k) as T) : empty);
  const [state, setState] = useState(() => ({ key, value: read(key) }));
  const current = state.key === key ? state.value : read(key);
  if (state.key !== key) setState({ key, value: current });

  const set = useCallback(
    (value: T) => {
      if (value === empty) kept.delete(key);
      else kept.set(key, value);
      setState({ key, value });
    },
    [key, empty],
  );
  return [current, set];
}

/** Forget every draft (tests). */
export function forgetCommentDrafts(): void {
  kept.clear();
}
