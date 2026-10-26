/**
 * Write addresses — read the optional `addresses` of a journaled write (the
 * comments it says it addresses) and refuse a malformed set before any
 * journal call.
 *
 * Key decisions:
 *   - Only the shape is checked here: an array of `c<n>` comment ids. The
 *     set rules (at most 64, no repeats, each an unresolved, undeleted comment
 *     of this document) are the journal's, under its writer lock, so they
 *     have one home; its refusal is answered INVALID_ADDRESSES too.
 *   - A malformed set is refused, never dropped: a write that silently lost
 *     its `addresses` would record no link while the agent believes it did.
 *   - An empty array is the same as none, so the prepare carries no field.
 *
 * @coordinates-with journaledEdit.ts — carries the set to the prepare
 * @coordinates-with src-tauri/src/agent_journal/comment/addresses.rs — the set rules
 * @module services/mcpBridge/v2/writeAddresses
 */

import { isCommentId } from "@/services/agentJournal/comments/commentReplies";
import { invalidAddressesError } from "./journalV2Error";
import { structuredError } from "./tabGuard";

/** A write's payload as `readOperationArgsChecked` read it. */
interface CheckedAddresses {
  wire: { addresses?: unknown };
  malformed: ReadonlySet<string>;
}

/**
 * The write's `addresses` to spread into its journaled edit (`{}` when none),
 * or `null` after answering INVALID_ADDRESSES.
 */
export async function requireAddresses(id: string, checked: CheckedAddresses): Promise<{ addresses?: string[] } | null> {
  const { addresses } = checked.wire;
  if (addresses === undefined && !checked.malformed.has("addresses")) return {};
  if (!Array.isArray(addresses) || !addresses.every(isCommentId)) {
    await structuredError(id, invalidAddressesError("addresses must be an array of comment ids (c<n>) from comments.list"));
    return null;
  }
  return addresses.length > 0 ? { addresses } : {};
}
