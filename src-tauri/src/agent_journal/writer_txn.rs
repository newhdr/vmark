//! Controlled mutations: `prepared` → `committed` | `aborted`, and the
//! maintenance `discarded` for an `uncommitted` entry.
//!
//! Prepare checks, in order: readable format, degraded, busy, parent CAS,
//! preimage = head text, then the op (slot admission, restore source,
//! revert CAS), then for a `hunkRevert` the revert plan (`writer_revert`):
//! a blocked span is `AMBIGUOUS_REVERT`, a revert that would not apply
//! cleanly or would edit another live hunk is `INVALID_REQUEST`. A refusal
//! appends nothing. A commit refused for its effects keeps the transaction
//! open so the worker can recompute; a caller that cannot recompute ends it
//! with `record_uncommitted`. A commit's `resolves` is bound to its
//! restore source (`review_rules::check_restore`).
//!
//! Every `committed` carries a provenance payload: the worker's
//! certified map (checked by `writer_epoch::check_payload`), the revert's
//! exact single change, a selection edit's checked certificate
//! (`certificate`), or a writer-built whole-document barrier.

use crate::agent_journal::effects_rules::{check_effects, EffectsCtx};
use crate::agent_journal::errors::TxnError;
use crate::agent_journal::ids::{BlobHash, DocId, RevisionId, TxnId};
use crate::agent_journal::projection::{TxnEntry, TxnStatus};
use crate::agent_journal::provenance::Certificate;
use crate::agent_journal::record::Record;
use crate::agent_journal::revert_gate::RevertDecision;
use crate::agent_journal::review::ReviewOp;
use crate::agent_journal::review_rules::{check_prepare, check_restore};
use crate::agent_journal::writer::certificate::Certification;
use crate::agent_journal::writer::{
    CommitOutcome, CommitRequest, Durability, Inner, PrepareRequest, Prepared, Reservation, Writer,
};
use crate::agent_journal::writer_degraded::Queued;
use crate::agent_journal::writer_epoch::{basis_of, certified_payload};
use crate::agent_journal::writer_revert::{plan, referenced_blob};

impl Writer {
    pub fn prepare(&self, req: PrepareRequest) -> Result<Prepared, TxnError> {
        self.prepare_in(&mut self.lock(), req)
    }

    /// `prepare` inside a caller's critical section (`g` is the held lock),
    /// so the checks before it and the reservation it takes are one step.
    pub(crate) fn prepare_in(
        &self,
        g: &mut Inner,
        req: PrepareRequest,
    ) -> Result<Prepared, TxnError> {
        req.actor.validate().map_err(TxnError::InvalidRequest)?;
        req.initiator.validate().map_err(TxnError::InvalidRequest)?;
        g.healthy()?;
        g.not_busy(req.doc)?;
        g.admit_reservation()?;
        let head = g.proj.head(req.doc);
        if head != req.parent {
            return Err(TxnError::StaleParent { head });
        }
        // The preimage is the head text; before the first revision the
        // recorded baseline is genesis `""`. Unsaved text is observed first.
        let pre = BlobHash::of_text(&req.preimage);
        if g.proj.postimage_of(head).as_ref() != Some(&pre) {
            return Err(TxnError::StaleParent { head });
        }
        if let Some(c) = &req.certificate {
            if c.basis() != basis_of(req.parent) || c.pre_hash() != pre.digest_hex() {
                return Err(TxnError::InvalidRequest(
                    "the certificate is not bound to the parent".into(),
                ));
            }
        }
        check_prepare(&g.proj, req.doc, &req.review_op)?;
        if let ReviewOp::HunkRevert { hunk_id, .. } = &req.review_op {
            let p = plan(&g.proj, &mut g.blobs, req.doc, hunk_id, &req.preimage)?;
            if !matches!(p.decision, RevertDecision::Apply { .. }) {
                return Err(TxnError::InvalidRequest(format!(
                    "the revert does not apply: {:?}",
                    p.decision
                )));
            }
        }
        let (txn, revision) = (TxnId::new(), RevisionId::new());
        let record = Record::Prepared {
            doc: req.doc,
            parent: req.parent,
            revision,
            preimage: pre.clone(),
            actor: req.actor,
            initiator: req.initiator,
            tool: req.tool,
            review_op: req.review_op,
            certificate: req.certificate,
        };
        let env = self.append(g, txn, record, &[(&pre, &req.preimage)])?;
        g.reservations.insert(req.doc, Reservation { txn });
        Ok(Prepared {
            txn,
            revision,
            generation: env.seq,
        })
    }

    pub fn commit(&self, txn: TxnId, req: CommitRequest) -> Result<CommitOutcome, TxnError> {
        self.commit_with(txn, req, None).map(|(out, _)| out)
    }

    /// `commit`, checking a selection edit's certificate (`sent` with the
    /// commit, else the prepared one): certified, its window and hunks;
    /// otherwise the barrier (`certificate`).
    pub(crate) fn commit_with(
        &self,
        txn: TxnId,
        req: CommitRequest,
        sent: Option<&Certificate>,
    ) -> Result<(CommitOutcome, Certification), TxnError> {
        let mut g = self.lock();
        // Refused, not queued: no content has changed yet.
        g.healthy()?;
        let t = open_txn(&g, txn)?;
        let post = BlobHash::of_text(&req.postimage);
        check_restore(&g.proj, &t, &post, req.resolves)?;
        let preimage = referenced_blob(&mut g.blobs, &t.preimage)?;
        let (window, reverted, certification) =
            self.commit_window(&mut g, &t, &preimage, &req, sent)?;
        let reverted_ref = reverted.as_ref().map(|(id, r)| (id, *r));
        let ctx = EffectsCtx {
            doc: g.proj.docs.get(&t.doc),
            op: &t.review_op,
            revision: t.revision,
            parent: t.parent,
            preimage: Some(&preimage),
            postimage: &req.postimage,
            window: &window,
            reverted: reverted_ref,
        };
        check_effects(&ctx, &req.effects)?;
        let basis = basis_of(t.parent);
        let payload = match req.provenance {
            Some(p) => p,
            None => certified_payload(&g.proj, t.doc, &basis, &preimage, &req.postimage, &window)?,
        };
        let record = Record::Committed {
            postimage: post.clone(),
            resolves: req.resolves,
            provenance: Some(payload),
            effects: req.effects,
        };
        let durable = self.terminal(&mut g, t.doc, txn, record, vec![(post, req.postimage)])?;
        let out = CommitOutcome {
            revision: t.revision,
            applied: true,
            durable,
        };
        Ok((out, certification))
    }

    pub fn abort(&self, txn: TxnId, reason: &str) -> Result<Durability, TxnError> {
        let mut g = self.lock();
        let t = open_txn(&g, txn)?;
        let durable = self.terminal(
            &mut g,
            t.doc,
            txn,
            Record::Aborted {
                reason: reason.into(),
            },
            vec![],
        )?;
        Ok(Durability { durable })
    }

    /// End an open transaction whose content may have changed but whose
    /// `committed` record cannot be written (the caller applied the text and
    /// its commit was refused): append `uncommitted`, as a reopen would, and
    /// release the reservation. A failed append queues it like any terminal
    /// record. Nothing is invented: the head does not move.
    pub fn record_uncommitted(&self, txn: TxnId) -> Result<Durability, TxnError> {
        let mut g = self.lock();
        let t = open_txn(&g, txn)?;
        let durable = self.terminal(&mut g, t.doc, txn, Record::Uncommitted, vec![])?;
        Ok(Durability { durable })
    }

    /// Resolve an `uncommitted` entry without restoring it.
    pub fn discard(&self, txn: TxnId) -> Result<Durability, TxnError> {
        let mut g = self.lock();
        let doc = match g.proj.txns.get(&txn) {
            Some(t) if t.status == TxnStatus::Uncommitted && !queued_discard(&g, t.doc, txn) => {
                t.doc
            }
            _ => {
                return Err(TxnError::InvalidRequest(
                    "only an uncommitted transaction can be discarded".into(),
                ))
            }
        };
        g.healthy()?;
        g.not_busy(doc)?;
        g.admit_reservation()?;
        let m = TxnId::new();
        g.reservations.insert(doc, Reservation { txn: m });
        let durable = self.terminal(&mut g, doc, m, Record::Discarded { resolves: txn }, vec![])?;
        Ok(Durability { durable })
    }

    /// Append a reservation-releasing record, or queue it if the append
    /// fails (keeping the reservation). Queues behind anything already
    /// queued for the document, preserving order. A record whose text
    /// would take the queue past the byte budget is refused instead
    /// (`JournalDegraded`), leaving the transaction open.
    fn terminal(
        &self,
        g: &mut Inner,
        doc: DocId,
        txn: TxnId,
        record: Record,
        blobs: Vec<(BlobHash, String)>,
    ) -> Result<bool, TxnError> {
        let queued = Queued {
            txn,
            record,
            blobs,
            window: None,
            releases: true,
        };
        if g.degraded.get(&doc).is_some_and(|q| !q.is_empty()) {
            g.admit_queued_terminal(&queued)?;
            g.degraded.entry(doc).or_default().push_back(queued);
            return Ok(false);
        }
        let refs: Vec<(&BlobHash, &str)> =
            queued.blobs.iter().map(|(h, t)| (h, t.as_str())).collect();
        match self.append(g, txn, queued.record.clone(), &refs) {
            Ok(_) => {
                g.reservations.remove(&doc);
                Ok(true)
            }
            Err(TxnError::Io(_)) => {
                g.admit_queued_terminal(&queued)?;
                g.degraded.entry(doc).or_default().push_back(queued);
                Ok(false)
            }
            Err(e) => Err(e),
        }
    }
}

/// The transaction is `prepared`, holds its document's reservation, and
/// its terminal record is not already queued.
pub(super) fn open_txn(g: &Inner, txn: TxnId) -> Result<TxnEntry, TxnError> {
    let t = g
        .proj
        .txns
        .get(&txn)
        .filter(|t| t.status == TxnStatus::Prepared);
    let holds = t.is_some_and(|t| g.reservations.get(&t.doc).is_some_and(|r| r.txn == txn));
    let queued = t.is_some_and(|t| {
        g.degraded
            .get(&t.doc)
            .is_some_and(|q| q.iter().any(|q| q.txn == txn))
    });
    match t {
        Some(t) if holds && !queued => Ok(t.clone()),
        _ => Err(TxnError::InvalidRequest("transaction is not open".into())),
    }
}

fn queued_discard(g: &Inner, doc: DocId, txn: TxnId) -> bool {
    g.degraded.get(&doc).is_some_and(|q| {
        q.iter()
            .any(|q| matches!(q.record, Record::Discarded { resolves } if resolves == txn))
    })
}
