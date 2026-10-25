/**
 * Lazy history parts
 *
 * Purpose: the review panel and the two-windows pair view load on first
 *   render instead of at startup. The history button lives in the status bar,
 *   which is part of the cold-start bundle, and neither part is needed until
 *   the popover opens.
 *
 * Key decisions:
 *   - Each part sits behind `RetryableLazy`, so a chunk that fails to load
 *     shows a local message with a retry that really retries, instead of a
 *     cached rejection reaching an outer boundary.
 *   - `load` is a prop with the real import as its default, so the failure
 *     path is tested through the component's contract, not a mocked module.
 *   - Only type imports reach the two parts statically; a value import would
 *     pull them back into the cold-start bundle.
 *
 * @coordinates-with components/RetryableLazy.tsx — the fresh-lazy-per-attempt mount
 * @coordinates-with components/ReviewPanel/ReviewPanel.tsx — the lazily loaded panel
 * @coordinates-with components/McpHistory/ConcurrentPairDiffs.tsx — the lazily loaded pair view
 * @module components/McpHistory/lazyHistoryParts
 */
import type { ComponentProps, ComponentType } from "react";
import { useTranslation } from "react-i18next";
import { RetryableLazy } from "@/components/RetryableLazy";
import type { ReviewPanel } from "@/components/ReviewPanel/ReviewPanel";
import type { ConcurrentPairDiffs } from "./ConcurrentPairDiffs";

type ReviewPanelProps = ComponentProps<typeof ReviewPanel>;
type PairProps = ComponentProps<typeof ConcurrentPairDiffs>;
type Loader<P> = () => Promise<{ default: ComponentType<P> }>;

const loadReviewPanel: Loader<ReviewPanelProps> = () =>
  import("@/components/ReviewPanel/ReviewPanel").then((m) => ({ default: m.ReviewPanel }));

const loadPairDiffs: Loader<PairProps> = () =>
  import("./ConcurrentPairDiffs").then((m) => ({ default: m.ConcurrentPairDiffs }));

function HistoryPartError({ onRetry }: { onRetry: () => void }): React.ReactElement {
  const { t } = useTranslation("statusbar");
  return (
    <p role="alert" className="mcp-history-part-error">
      {t("review.loadFailed")}{" "}
      <button type="button" className="vm-btn vm-btn--compact" onClick={onRetry}>
        {t("review.retryLoad")}
      </button>
    </p>
  );
}

export function LazyReviewPanel({ load = loadReviewPanel, ...props }: ReviewPanelProps & { load?: Loader<ReviewPanelProps> }): React.ReactElement {
  return (
    <RetryableLazy feature="Review panel" load={load} componentProps={props} renderError={(retry) => <HistoryPartError onRetry={retry} />} />
  );
}

export function LazyConcurrentPairDiffs({ load = loadPairDiffs, ...props }: PairProps & { load?: Loader<PairProps> }): React.ReactElement {
  return (
    <RetryableLazy feature="Two-windows pair view" load={load} componentProps={props} renderError={(retry) => <HistoryPartError onRetry={retry} />} />
  );
}
