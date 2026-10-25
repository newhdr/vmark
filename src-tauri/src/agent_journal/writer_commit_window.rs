//! Which map a commit's effects are derived from: a `hunkRevert`'s own
//! exact change (`writer_revert`), a selection edit's certificate once
//! checked (`certificate`; a failed one falls back to the barrier), a
//! writer-built whole-document barrier
//! (`wholeDocumentWrite` for `review`, `snapshotOnly` for `none`, `restore`
//! for a restore), or the worker's payload once `check_payload` accepts it.
//! Split from `writer_txn` to keep each file readable.
//!
//! @module agent_journal/writer_commit_window

use crate::agent_journal::errors::TxnError;
use crate::agent_journal::ids::HunkId;
use crate::agent_journal::projection::TxnEntry;
use crate::agent_journal::provenance::{BreakReason, Certificate, Provenance};
use crate::agent_journal::revert_gate::RevertDecision;
use crate::agent_journal::review::{Range, ReviewEffects, ReviewOp};
use crate::agent_journal::writer::certificate::{certify_commit, Certification};
use crate::agent_journal::writer::{CommitRequest, Inner, Writer};
use crate::agent_journal::writer_epoch::{basis_of, check_payload, whole_window};
use crate::agent_journal::writer_revert::plan;

/// The hunk a `hunkRevert` reverts, the range it restores, and the effects
/// its plan derived (the only effects such a commit may carry).
pub(super) type Reverted = (HunkId, Range, ReviewEffects);

/// A commit window, the revert it applies, and its certification.
type Window = (Provenance, Option<Reverted>, Certification);

impl Writer {
    /// The map a commit's effects are derived from: the revert's own
    /// change, a selection edit's certificate (`sent`, else the prepared
    /// one) once checked, a writer-built barrier, or the worker's payload.
    pub(super) fn commit_window(
        &self,
        g: &mut Inner,
        t: &TxnEntry,
        preimage: &str,
        req: &CommitRequest,
        sent: Option<&Certificate>,
    ) -> Result<Window, TxnError> {
        let refuse = |what: &str| Err(TxnError::InvalidRequest(what.into()));
        let barrier = |reason, origin| whole_window(preimage, &req.postimage, reason, origin);
        let plain = |w: Provenance| (w, None, Certification::Absent);
        match (&t.review_op, &req.provenance) {
            (ReviewOp::Review, None) => {
                let agent = || barrier(BreakReason::WholeDocumentWrite, "agent");
                Ok(
                    match certify_commit(g, t, preimage, &req.postimage, sent)? {
                        None => plain(agent()?),
                        Some(Ok((w, hunks))) => (w, None, Certification::Certified(hunks)),
                        Some(Err(r)) => (agent()?, None, Certification::Fallback(r)),
                    },
                )
            }
            _ if sent.is_some() => refuse("a certificate is for a review write without provenance"),
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
                        Ok((
                            w,
                            Some((hunk_id.clone(), r, p.effects)),
                            Certification::Absent,
                        ))
                    }
                    _ => refuse("the postimage is not the revert of the hunk"),
                }
            }
            (ReviewOp::Restore { .. }, None) => {
                Ok(plain(barrier(BreakReason::Restore, "restore")?))
            }
            (ReviewOp::None, None) => Ok(plain(barrier(BreakReason::SnapshotOnly, "snapshot")?)),
            (_, Some(p)) => {
                let window = check_payload(
                    &g.proj,
                    t.doc,
                    &basis_of(t.parent),
                    preimage,
                    &req.postimage,
                    p,
                )?;
                Ok(plain(window))
            }
        }
    }
}
