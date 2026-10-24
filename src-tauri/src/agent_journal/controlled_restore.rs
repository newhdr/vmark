//! Restore as a controlled mutation: the history panel puts an earlier
//! text back — a revision, the preimage of an `uncommitted` transaction, or
//! a legacy checkpoint — through the same protocol as an agent write.
//!
//! Prepare, in order: the source is resolved and checked first (an unknown,
//! collected or foreign source, or full restore slots, refuses with nothing
//! appended); then the controlled prepare — admission, parent CAS, pending
//! captures, the overwritten buffer recorded as a human baseline, the
//! writer's prepare with `reviewOp: restore`. The whole of it holds the
//! writer lock, so the source read is the source reserved. The reply hands
//! the window the source text to apply.
//!
//! Key decisions:
//!   - Attributed to the person (`human` actor and initiator): a restore is
//!     the user's own action from the history panel.
//!   - The window never names what the restore resolves or how it is
//!     reviewed: the commit reads `resolves` from the prepared source and
//!     the writer derives the single `restore` hunk (whole parent text →
//!     whole restored text), so reverting it gives the overwritten text
//!     back, and a `restore` barrier blocks every older live hunk without
//!     superseding it.
//!   - Commit and abort are the controlled write's own (`commit_controlled`,
//!     `abort_controlled`): a refused commit ends the transaction
//!     `uncommitted`.
//!
//! @module agent_journal/controlled_restore

use serde::{Deserialize, Serialize};

use crate::agent_journal::actor::Actor;
use crate::agent_journal::controlled::{prepare_after_baseline, Prep};
use crate::agent_journal::controlled_wire::decode;
use crate::agent_journal::errors::TxnError;
use crate::agent_journal::ids::{DocId, RevisionId, TxnId};
use crate::agent_journal::provenance_field::{decode_field, ProvenanceField};
use crate::agent_journal::review::{RestoreSource, ReviewOp};
use crate::agent_journal::review_rules::{check_prepare, restore_resolves, restore_text};
use crate::agent_journal::writer::{Inner, Writer};
use crate::agent_journal::writer_revert::referenced_blob;

/// The tool name a restore's transaction records.
pub const RESTORE_TOOL: &str = "history.restore";

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RestorePrepareRequest {
    pub doc_key: String,
    /// The revision the window last learned from the journal (CAS).
    #[serde(default)]
    pub parent: Option<RevisionId>,
    /// The window's current buffer: the text the restore overwrites.
    pub preimage: String,
    pub source: RestoreSource,
    #[serde(default)]
    pub baseline_provenance: Option<ProvenanceField>,
    #[serde(default)]
    pub baseline_touched: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestorePrepared {
    pub doc: DocId,
    pub txn: TxnId,
    pub revision: RevisionId,
    #[serde(with = "crate::agent_journal::u64_wire")]
    pub generation: u64,
    /// The human revision recorded for the overwritten buffer, if any.
    pub baseline: Option<RevisionId>,
    /// The text to apply.
    pub text: String,
    /// The `uncommitted` transaction this restore resolves, if any.
    pub resolves: Option<TxnId>,
}

/// Decode a restore prepare payload (`INVALID_TEXT`, then the shape).
pub fn decode_restore_prepare(payload: &[u8]) -> Result<RestorePrepareRequest, TxnError> {
    decode(payload)
}

/// The text `source` holds for `doc`, after the prepare-time checks.
fn source_text(
    g: &mut Inner,
    doc: DocId,
    op: &ReviewOp,
    source: &RestoreSource,
) -> Result<(String, Option<TxnId>), TxnError> {
    check_prepare(&g.proj, doc, op)?;
    let hash = restore_text(&g.proj, doc, source)
        .cloned()
        .ok_or_else(|| TxnError::InvalidRequest("restore source does not exist".into()))?;
    let text = referenced_blob(&mut g.blobs, &hash)?;
    Ok((text, restore_resolves(source)))
}

/// Prepare a restore of `doc`. See the module docs for the order.
pub fn prepare_restore(
    w: &Writer,
    doc: DocId,
    req: RestorePrepareRequest,
) -> Result<RestorePrepared, TxnError> {
    let baseline_provenance = decode_field(req.baseline_provenance)?;
    let review_op = ReviewOp::Restore {
        source: req.source.clone(),
    };
    // One critical section from the source check to the reservation: a
    // collection or discard cannot invalidate the source in between.
    let mut g = w.lock();
    let (text, resolves) = source_text(&mut g, doc, &review_op, &req.source)?;
    let prepared = prepare_after_baseline(
        w,
        &mut g,
        doc,
        Prep {
            parent: req.parent,
            preimage: req.preimage,
            actor: Actor::Human,
            initiator: Actor::Human,
            tool: RESTORE_TOOL.into(),
            review_op,
            baseline_provenance,
            baseline_touched: req.baseline_touched,
        },
    )?;
    Ok(RestorePrepared {
        doc,
        txn: prepared.txn,
        revision: prepared.revision,
        generation: prepared.generation,
        baseline: prepared.baseline,
        text,
        resolves,
    })
}
