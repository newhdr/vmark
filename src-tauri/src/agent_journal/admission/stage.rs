//! Staging a multi-record prepare as one `admission` frame: every pending
//! capture of the document linearized, the buffer recorded as a human
//! baseline (its observation and linearization) when it is needed, then
//! the `prepared` with its reply and receipt. Each item is checked and
//! applied to a clone of the projection, reading texts through the pack
//! overlaid with the blobs the frame will store, so every item derives
//! from exactly the state the replay will have reached. The live
//! projection, the pack and the journal are untouched until the publish;
//! a refusal here drops the clone and the staged blobs. Staging is handed
//! the projection read-only and the pack, never `&mut Inner`, so it cannot
//! reach a writer helper that mutates state (window bases, the budget's
//! unpinned sets, the degraded queue).
//!
//! @module agent_journal/admission/stage

use crate::agent_journal::actor::Actor;
use crate::agent_journal::admission::blobs::StagedBlobs;
use crate::agent_journal::admission::prepare::{
    needs_baseline, prepare_request, Minted, Request, Responder,
};
use crate::agent_journal::admission::prepared_record::prepared_record;
use crate::agent_journal::admission::publish::Staging;
use crate::agent_journal::admission::reduce::preflight;
use crate::agent_journal::blob_store::BlobStore;
use crate::agent_journal::controlled::Prep;
use crate::agent_journal::effects_rules::{check_effects, EffectsCtx};
use crate::agent_journal::errors::TxnError;
use crate::agent_journal::ids::{BlobHash, DocId, RevisionId, TxnId};
use crate::agent_journal::projection::Projection;
use crate::agent_journal::record::{Envelope, ObservedRef, Record, SCHEMA_V3};
use crate::agent_journal::review::ReviewOp;
use crate::agent_journal::writer::certificate::bind_to_parent;
use crate::agent_journal::writer_derive::{derived, linearize_ctx_from};
use crate::agent_journal::writer_epoch::{check_payload, observed_basis};
use crate::agent_journal::writer_observe::linearized_record;
use crate::agent_journal::writer_revert::referenced_blob;
use crate::agent_journal::writer_types::now_ms;

/// The items staged so far, applied to `proj` as they are pushed.
struct Frame {
    proj: Projection,
    items: Vec<Envelope>,
    next_seq: u64,
    at: u64,
}

impl Frame {
    /// Stamp `record` as the next item, check it and apply it to the clone.
    fn push(&mut self, txn: TxnId, record: Record) -> Result<u64, TxnError> {
        self.push_receipted(txn, record, None)
    }

    fn push_receipted(
        &mut self,
        txn: TxnId,
        record: Record,
        receipt: Option<crate::agent_journal::admission::receipt::Receipt>,
    ) -> Result<u64, TxnError> {
        let seq = self.next_seq;
        let env = Envelope {
            schema_version: SCHEMA_V3,
            seq,
            txn,
            at: self.at,
            record,
            receipt,
        };
        self.proj
            .apply(&env)
            .map_err(|e| TxnError::Invariant(format!("staged item {seq}: {e}")))?;
        self.items.push(env);
        self.next_seq = seq
            .checked_add(1)
            .filter(|s| *s < u64::MAX)
            .ok_or_else(|| TxnError::Io("journal generation exhausted".into()))?;
        Ok(seq)
    }

    /// Linearize every pending capture of `doc`, oldest first.
    fn linearize_pending(
        &mut self,
        blobs: &mut StagedBlobs<'_>,
        doc: DocId,
    ) -> Result<(), TxnError> {
        while let Some(ctx) = linearize_ctx_from(&self.proj, blobs, doc)? {
            let effects = derived(
                &self.proj,
                doc,
                ctx.head,
                &ReviewOp::None,
                &ctx.window,
                &ctx.post,
                Vec::new(),
            )?;
            let revision = RevisionId::new();
            check_effects(
                &EffectsCtx {
                    doc: self.proj.docs.get(&doc),
                    op: &ReviewOp::None,
                    revision,
                    parent: ctx.head,
                    preimage: None,
                    postimage: &ctx.post,
                    window: &ctx.window,
                    reverted: None,
                },
                &effects,
            )?;
            let observation = ctx.observation;
            self.push(observation, linearized_record(ctx, revision, effects))?;
        }
        Ok(())
    }
}

/// What staging may read: the live projection and the pack.
pub(crate) struct Live<'a> {
    pub proj: &'a Projection,
    pub pack: &'a mut BlobStore,
    /// The seq the frame's first item takes.
    pub next_seq: u64,
}

/// Stage the frame for a prepare of `doc` that appends more than one
/// record, from `live` (read-only but for pack reads). Runs after
/// admission, in the caller's critical section.
pub(crate) fn staged(
    live: Live<'_>,
    doc: DocId,
    prep: Prep,
    responder: &Responder,
    request: Option<&Request>,
) -> Result<Staging, TxnError> {
    let mut f = Frame {
        proj: live.proj.clone(),
        items: Vec::new(),
        next_seq: live.next_seq,
        at: now_ms(),
    };
    let mut blobs = StagedBlobs::new(live.pack);
    f.linearize_pending(&mut blobs, doc)?;
    let head = f.proj.head(doc);
    let baseline = if needs_baseline(&f.proj, head, &prep) {
        stage_baseline(&mut f, &mut blobs, doc, head, &prep)?;
        f.linearize_pending(&mut blobs, doc)?;
        f.proj.head(doc)
    } else {
        None
    };
    let parent = f.proj.head(doc);
    let (mut req, sent) = prepare_request(prep, doc, parent);
    let (certificate, fallback) =
        bind_to_parent(&f.proj, doc, parent, &req.preimage, sent)?.split();
    let certified = certificate.is_some();
    req.certificate = certificate;
    let r = prepared_record(&f.proj, &mut blobs, req)?;
    blobs.stage(&r.preimage);
    let minted = Minted {
        txn: r.txn,
        revision: r.revision,
        generation: f.next_seq,
        baseline,
        certified,
        fallback_reason: fallback,
    };
    let receipt = responder.receipt(request, &minted);
    f.push_receipted(r.txn, r.record, receipt)?;
    let staged_blobs = blobs.into_staged();
    let frame = Envelope {
        schema_version: SCHEMA_V3,
        seq: f.items[0].seq,
        txn: r.txn,
        at: f.at,
        record: Record::Admission { items: f.items },
        receipt: None,
    };
    preflight(live.proj, &frame)
        .map_err(|e| TxnError::Invariant(format!("staged admission: {e}")))?;
    Ok(Staging {
        env: frame,
        blobs: staged_blobs,
        staged: Some(f.proj),
        doc,
        txn: r.txn,
        response: responder.reply(&minted),
        fallback,
    })
}

/// Push the buffer's capture as a human observation of `head`, caused by
/// the initiator's write, with its texts staged and its map checked
/// against the head's text.
fn stage_baseline(
    f: &mut Frame,
    blobs: &mut StagedBlobs<'_>,
    doc: DocId,
    head: Option<RevisionId>,
    prep: &Prep,
) -> Result<(), TxnError> {
    let (observed_parent, observed_preimage) = match head {
        Some(revision) => (
            ObservedRef::Revision { revision },
            f.proj
                .postimage_of(head)
                .ok_or_else(|| TxnError::Invariant("head has no text".into()))?,
        ),
        None => (ObservedRef::Genesis, BlobHash::of_text("")),
    };
    let provenance = prep.baseline_provenance.clone();
    if provenance.is_some() || !blobs_hold(blobs, &observed_preimage) {
        let pre = referenced_blob(blobs, &observed_preimage)?;
        if let Some(payload) = &provenance {
            let basis = observed_basis(&observed_parent);
            check_payload(&f.proj, doc, &basis, &pre, &prep.preimage, payload)?;
        }
        blobs.stage(&pre);
    }
    blobs.stage(&prep.preimage);
    let record = Record::PendingObservation {
        doc,
        actor: Actor::Human,
        initiator: prep.initiator.clone(),
        postimage: BlobHash::of_text(&prep.preimage),
        observed_parent,
        observed_preimage,
        provenance,
    };
    f.push(TxnId::new(), record)?;
    Ok(())
}

fn blobs_hold(blobs: &StagedBlobs<'_>, hash: &BlobHash) -> bool {
    use crate::agent_journal::admission::blobs::BlobRead as _;
    blobs.contains(hash)
}
