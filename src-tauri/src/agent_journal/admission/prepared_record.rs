//! The `prepared` record a prepare mints, after the checks that follow
//! admission: parent CAS, preimage = head text, the certificate's binding,
//! the op (slot admission, restore source, revert CAS) and a revert's plan.
//! Pure over a projection and a blob view, so the writer's single-record
//! prepare and a staged admission (checked against its clone, after the
//! items before it) run the same checks and mint the same record.
//!
//! @module agent_journal/admission/prepared_record

use crate::agent_journal::admission::blobs::BlobRead;
use crate::agent_journal::errors::TxnError;
use crate::agent_journal::ids::{BlobHash, RevisionId, TxnId};
use crate::agent_journal::projection::Projection;
use crate::agent_journal::record::Record;
use crate::agent_journal::revert_gate::RevertDecision;
use crate::agent_journal::review::ReviewOp;
use crate::agent_journal::review_rules::check_prepare;
use crate::agent_journal::writer::PrepareRequest;
use crate::agent_journal::writer_epoch::basis_of;
use crate::agent_journal::writer_revert::plan;

/// A `prepared` record minted against `p`, with the preimage text it
/// names (stored before the record).
pub(crate) struct PreparedRecord {
    pub(crate) txn: TxnId,
    pub(crate) revision: RevisionId,
    pub(crate) record: Record,
    pub(crate) pre: BlobHash,
    pub(crate) preimage: String,
}

/// Prepare's checks after admission — parent CAS, preimage = head text,
/// the certificate's binding, the op, a revert's plan — against `p` and
/// `blobs`, then the minted record. Appends nothing: the caller writes it
/// alone or as an admission's last item.
pub(crate) fn prepared_record(
    p: &Projection,
    blobs: &mut dyn BlobRead,
    req: PrepareRequest,
) -> Result<PreparedRecord, TxnError> {
    let head = p.head(req.doc);
    if head != req.parent {
        return Err(TxnError::StaleParent { head });
    }
    // The preimage is the head text; before the first revision the
    // recorded baseline is genesis `""`. Unsaved text is observed first.
    let pre = BlobHash::of_text(&req.preimage);
    if p.postimage_of(head).as_ref() != Some(&pre) {
        return Err(TxnError::StaleParent { head });
    }
    if let Some(c) = &req.certificate {
        if c.basis() != basis_of(req.parent) || c.pre_hash() != pre.digest_hex() {
            return Err(TxnError::InvalidRequest(
                "the certificate is not bound to the parent".into(),
            ));
        }
    }
    check_prepare(p, req.doc, &req.review_op)?;
    if let ReviewOp::HunkRevert { hunk_id, .. } = &req.review_op {
        let plan = plan(p, blobs, req.doc, hunk_id, &req.preimage)?;
        if !matches!(plan.decision, RevertDecision::Apply { .. }) {
            return Err(TxnError::InvalidRequest(format!(
                "the revert does not apply: {:?}",
                plan.decision
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
    Ok(PreparedRecord {
        txn,
        revision,
        record,
        pre,
        preimage: req.preimage,
    })
}
