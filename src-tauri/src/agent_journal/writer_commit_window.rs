//! Which map a commit's effects are derived from: a `hunkRevert`'s own
//! exact change (`writer_revert`), a writer-built whole-document barrier
//! (`wholeDocumentWrite` for `review`, `snapshotOnly` for `none`, `restore`
//! for a restore), or the worker's payload once `check_payload` accepts it.
//! Split from `writer_txn` to keep each file readable.
//!
//! @module agent_journal/writer_commit_window

use crate::agent_journal::errors::TxnError;
use crate::agent_journal::ids::HunkId;
use crate::agent_journal::projection::TxnEntry;
use crate::agent_journal::provenance::{BreakReason, Provenance};
use crate::agent_journal::revert_gate::RevertDecision;
use crate::agent_journal::review::{Range, ReviewOp};
use crate::agent_journal::writer::{CommitRequest, Inner, Writer};
use crate::agent_journal::writer_epoch::{basis_of, check_payload, whole_window};
use crate::agent_journal::writer_revert::plan;

impl Writer {
    /// The map a commit's effects are derived from: the revert's own
    /// change, a writer-built barrier, or the worker's checked payload.
    pub(super) fn commit_window(
        &self,
        g: &mut Inner,
        t: &TxnEntry,
        preimage: &str,
        req: &CommitRequest,
    ) -> Result<(Provenance, Option<(HunkId, Range)>), TxnError> {
        let refuse = |what: &str| Err(TxnError::InvalidRequest(what.into()));
        let barrier = |reason, origin| whole_window(preimage, &req.postimage, reason, origin);
        match (&t.review_op, &req.provenance) {
            (ReviewOp::HunkRevert { .. } | ReviewOp::Restore { .. }, Some(_)) => {
                refuse("a hunkRevert or restore carries no worker provenance")
            }
            (ReviewOp::HunkRevert { hunk_id, .. }, None) => {
                let inner = &mut *g;
                let p = plan(&inner.proj, &mut inner.blobs, t.doc, hunk_id, preimage)?;
                match (p.decision, p.window) {
                    (RevertDecision::Apply { postimage, .. }, Some((w, r)))
                        if postimage == req.postimage =>
                    {
                        Ok((w, Some((hunk_id.clone(), r))))
                    }
                    _ => refuse("the postimage is not the revert of the hunk"),
                }
            }
            (ReviewOp::Restore { .. }, None) => {
                Ok((barrier(BreakReason::Restore, "restore")?, None))
            }
            (ReviewOp::Review, None) => {
                Ok((barrier(BreakReason::WholeDocumentWrite, "agent")?, None))
            }
            (ReviewOp::None, None) => Ok((barrier(BreakReason::SnapshotOnly, "snapshot")?, None)),
            (_, Some(p)) => {
                let window = check_payload(
                    &g.proj,
                    t.doc,
                    &basis_of(t.parent),
                    preimage,
                    &req.postimage,
                    p,
                )?;
                Ok((window, None))
            }
        }
    }
}
