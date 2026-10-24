//! `document.write` on the controlled-mutation protocol, as a window drives
//! it: prepare (after recording unjournaled buffer text as a baseline),
//! then commit or abort. The window re-verifies its editor between prepare
//! and apply; this side only records what the window reports.
//!
//! Prepare, in order: actor is an MCP actor, writer healthy, document not
//! degraded or reserved (nothing appended when refused), parent CAS against
//! the revision the window last saw, linearize pending captures, record the
//! buffer as a human baseline when it differs from the head, then the
//! writer's own prepare (preimage = head text). All of it is one writer
//! critical section, so a racing prepare cannot slip in after admission:
//! the loser is refused with nothing appended (ADR-AL6). Abort records why
//! re-verification failed.
//!
//! Review effects are derived by the writer, never sent by the window. A
//! commit is a `wholeDocumentWrite` barrier (every older live hunk
//! blocked, none silently moved) unless a `selection.set` certificate,
//! sent with the prepare or the commit, checks (`certificate`). The
//! baseline carries the map flushed for unsaved edits
//! (`baselineProvenance`); without one it is a `snapshotOnly` barrier. A
//! refused commit ends the transaction `uncommitted` (no retry).
//!
//! @module agent_journal/controlled

use crate::agent_journal::actor::Actor;
use crate::agent_journal::errors::TxnError;
use crate::agent_journal::ids::{BlobHash, DocId, RevisionId, TxnId};
use crate::agent_journal::provenance::{Certificate, ProvenancePayload};
use crate::agent_journal::provenance_field::decode_field;
use crate::agent_journal::record::ObservedRef;
use crate::agent_journal::review::ReviewOp;
use crate::agent_journal::writer::certificate::{bind_to_parent, note_fallback};
use crate::agent_journal::writer::{
    CommitRequest, Durability, Inner, LinearizeRequest, ObserveRequest, PrepareRequest, Writer,
};
use crate::agent_journal::writer_derive::linearize_effects_in;
use crate::agent_journal::writer_observe::Journaled;

use crate::agent_journal::controlled_restore::restored_uncommitted;
use crate::agent_journal::controlled_wire::{decode, ControlledCommitRequest};
pub use crate::agent_journal::controlled_wire::{
    decode_prepare, AbortReason, ControlledCommitted, ControlledPrepareRequest, ControlledPrepared,
    TOOL_MAX_BYTES,
};

/// Prepare a controlled write of `doc`. See the module docs for the order.
pub fn prepare_controlled(
    w: &Writer,
    doc: DocId,
    req: ControlledPrepareRequest,
) -> Result<ControlledPrepared, TxnError> {
    req.actor.validate().map_err(TxnError::InvalidRequest)?;
    let baseline_provenance = decode_field(req.baseline_provenance.clone())?;
    prepare_after_baseline(
        w,
        &mut w.lock(),
        doc,
        Prep {
            parent: req.parent,
            preimage: req.preimage,
            actor: req.actor.clone(),
            initiator: req.actor,
            tool: req.tool,
            review_op: ReviewOp::Review,
            baseline_provenance,
            baseline_touched: req.baseline_touched,
            certificate: req.certificate,
        },
    )
}

/// What a controlled prepare needs, whoever drives it.
pub(crate) struct Prep {
    pub(crate) parent: Option<RevisionId>,
    pub(crate) preimage: String,
    pub(crate) actor: Actor,
    pub(crate) initiator: Actor,
    pub(crate) tool: String,
    pub(crate) review_op: ReviewOp,
    pub(crate) baseline_provenance: Option<ProvenancePayload>,
    pub(crate) baseline_touched: bool,
    pub(crate) certificate: Option<Certificate>,
}

/// Admission, parent CAS, pending captures, the baseline, then the
/// writer's prepare — the order the module docs give — in the caller's one
/// critical section (`g` is the held writer lock). Nothing can interleave
/// between admission and the reservation, so a prepare that loses a race
/// is refused at admission or the CAS, before it appends anything.
pub(crate) fn prepare_after_baseline(
    w: &Writer,
    g: &mut Inner,
    doc: DocId,
    prep: Prep,
) -> Result<ControlledPrepared, TxnError> {
    admit(g, doc)?;
    let mut head = g.proj.head(doc);
    if prep.parent.is_some_and(|p| Some(p) != head) {
        return Err(TxnError::StaleParent { head });
    }
    while let Some(done) = linearize_one_in(w, g, doc, head)? {
        head = Some(done);
    }
    let baseline = record_baseline(w, g, doc, head, &prep)?;
    let parent = baseline.or(head);
    let (certificate, fallback_reason) =
        bind_to_parent(g, doc, parent, &prep.preimage, prep.certificate)?.split();
    let certified = certificate.is_some();
    let prepared = w.prepare_in(
        g,
        PrepareRequest {
            doc,
            parent,
            preimage: prep.preimage,
            actor: prep.actor,
            initiator: prep.initiator,
            tool: prep.tool,
            review_op: prep.review_op,
            certificate,
        },
    )?;
    if let Some(r) = fallback_reason {
        note_fallback(g, doc, r);
    }
    Ok(ControlledPrepared {
        doc,
        txn: prepared.txn,
        revision: prepared.revision,
        generation: prepared.generation,
        baseline,
        certified,
        fallback_reason,
    })
}

/// Healthy, not degraded or reserved, and room for a reservation; nothing
/// is appended when refused.
fn admit(g: &Inner, doc: DocId) -> Result<(), TxnError> {
    g.healthy()?;
    g.not_busy(doc)?;
    g.admit_reservation()
}

/// Record the buffer as a human revision on the head, caused by the
/// initiator's write. `None` when it equals the head's text and nothing says a
/// person touched it: no map that deletes or breaks anything, and the
/// window does not mark it touched. Text equality alone does not decide
/// it: a deleted and retyped character is a person's, not the agent's.
fn record_baseline(
    w: &Writer,
    g: &mut Inner,
    doc: DocId,
    head: Option<RevisionId>,
    prep: &Prep,
) -> Result<Option<RevisionId>, TxnError> {
    let head_hash = g.proj.postimage_of(head);
    let provenance = prep.baseline_provenance.clone();
    let touched =
        prep.baseline_touched || provenance.as_ref().is_some_and(|p| !p.touches_nothing());
    if !touched && head_hash.as_ref() == Some(&BlobHash::of_text(&prep.preimage)) {
        return Ok(None);
    }
    let observed_parent = head.map_or(ObservedRef::Genesis, |revision| ObservedRef::Revision {
        revision,
    });
    let observed = w.observe_in(
        g,
        ObserveRequest {
            doc,
            actor: Actor::Human,
            initiator: prep.initiator.clone(),
            postimage: prep.preimage.clone(),
            observed_parent,
            provenance,
        },
        None,
    )?;
    if observed.journaled == Journaled::No {
        return Err(TxnError::JournalDegraded);
    }
    linearize_one_in(w, g, doc, head)
}

/// Linearize the oldest pending observation of `doc` with the effects the
/// writer derives for it. `None` when nothing is pending.
pub(crate) fn linearize_one(
    w: &Writer,
    doc: DocId,
    head: Option<RevisionId>,
) -> Result<Option<RevisionId>, TxnError> {
    linearize_one_in(w, &mut w.lock(), doc, head)
}

/// `linearize_one` inside a caller's critical section: the effects are
/// derived and appended under the same lock.
fn linearize_one_in(
    w: &Writer,
    g: &mut Inner,
    doc: DocId,
    head: Option<RevisionId>,
) -> Result<Option<RevisionId>, TxnError> {
    let Some(effects) = linearize_effects_in(g, doc)? else {
        return Ok(None);
    };
    let done = w.linearize_next_in(
        g,
        doc,
        LinearizeRequest {
            expected_head: head,
            effects,
        },
    )?;
    Ok(done.map(|l| l.revision))
}

/// Commit `txn` with the applied text: certified through a checked
/// selection certificate, else a `wholeDocumentWrite` barrier (a `restore`
/// barrier for a restore, which also resolves the uncommitted transaction
/// it restores — read from the prepared op, never sent).
///
/// The window commits only after applying, and never retries a refused
/// commit, so a refusal for a known open transaction also ends it as
/// `uncommitted` (releasing the reservation, or queued behind a failed
/// append). The refusal is still returned: the window reports the write
/// applied but not durable.
pub fn commit_controlled(
    w: &Writer,
    txn: TxnId,
    payload: &[u8],
) -> Result<ControlledCommitted, TxnError> {
    let doc = txn_doc(w, txn).ok_or_else(unknown_txn)?;
    let committed = decode::<ControlledCommitRequest>(payload).and_then(|req| {
        let sent = req.certificate.as_ref();
        let mut commit = CommitRequest {
            postimage: req.postimage,
            resolves: restored_uncommitted(w, txn),
            provenance: None,
            effects: Default::default(),
        };
        commit.effects = w.derive_commit_effects_with(txn, &commit, sent)?;
        w.commit_with(txn, commit, sent)
    });
    match committed {
        Ok((out, certification)) => {
            let (certified, fallback_reason) = w.report_certification(doc, &certification);
            Ok(ControlledCommitted {
                doc,
                revision: out.revision,
                applied: out.applied,
                durable: out.durable,
                certified,
                fallback_reason,
            })
        }
        Err(e) => {
            end_unrecorded(w, txn, &e);
            Err(e)
        }
    }
}

/// End a transaction whose commit was refused after the apply. A
/// transaction that is no longer open (already committed, or its terminal
/// record queued) is left as it is.
fn end_unrecorded(w: &Writer, txn: TxnId, cause: &TxnError) {
    match w.record_uncommitted(txn) {
        Ok(d) => log::error!(
            "agent journal: commit of {} refused after apply ({cause}); recorded uncommitted (durable: {})",
            txn.0,
            d.durable
        ),
        Err(e) => log::warn!(
            "agent journal: commit of {} refused ({cause}); transaction not open ({e})",
            txn.0
        ),
    }
}

/// Abort `txn` because re-verification failed. A failed append keeps the
/// reservation and queues the record (`durable: false`).
pub fn abort_controlled(
    w: &Writer,
    txn: TxnId,
    reason: AbortReason,
) -> Result<Durability, TxnError> {
    txn_doc(w, txn).ok_or_else(unknown_txn)?;
    w.abort(txn, &reason.record_text())
}

/// The document `txn` belongs to, if the journal knows the transaction.
pub fn txn_doc(w: &Writer, txn: TxnId) -> Option<DocId> {
    w.lock().proj.txns.get(&txn).map(|t| t.doc)
}

fn unknown_txn() -> TxnError {
    TxnError::InvalidRequest("transaction is not open".into())
}
