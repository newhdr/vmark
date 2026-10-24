//! A framed prepare: an agent write or a restore whose payload names the
//! writer incarnation and the page (generation and identity) it was frozen
//! for, answered by the request protocol.
//!
//! Order, in the first critical section: the payload's incarnation is the
//! writer's; its generation is live for the invoking label with that
//! identity; the receipt lookup (an executable identical retry gets its
//! stored reply); then the in-flight, sealed, fenced and bound checks of
//! `requests`, which take the attempt's in-flight entry. The document is
//! resolved outside the lock. The second critical section re-checks the
//! generation and that the entry is still the attempt's (an abandon takes
//! it), runs the prepare, and on success swaps the entry for the
//! transaction's owner in the same step.
//!
//! Key decisions:
//!   - The identity fields are decoded by `payload` before anything is
//!     read, and record nothing when malformed.
//!   - A refusal after the entry was taken fences the id (`notAdmitted`),
//!     except a request answer (the receipt's) and a failure that left the
//!     writer unhealthy (`unavailable`: the attempt's fate is not known).
//!   - An answer read from the receipt restarts its document's drain when
//!     degraded (`reconcile`); a refusal from the prepare does the same
//!     through `settle_prepare`.
//!
//! @module agent_journal/admission/framed

use std::collections::HashSet;

use crate::agent_journal::admission::answer::RequestState;
use crate::agent_journal::admission::bound::{Bound, RequestBind};
use crate::agent_journal::admission::page_table::{Liveness, PageTable};
use crate::agent_journal::admission::payload::{admit_identity, Frame};
use crate::agent_journal::admission::prepare::{prepare_admitted, Request};
use crate::agent_journal::admission::receipt::PreparedResponse;
use crate::agent_journal::admission::reconcile::{lookup, receipt_doc};
use crate::agent_journal::admission::requests::{Owner, RequestGuard};
use crate::agent_journal::controlled::{controlled_prep, decode_prepare, reused_id, Prep};
use crate::agent_journal::controlled_restore::{
    decode_restore_prepare, restore_prep, RestorePrepared,
};
use crate::agent_journal::controlled_wire::ControlledPrepared;
use crate::agent_journal::controller::Controller;
use crate::agent_journal::errors::TxnError;
use crate::agent_journal::ids::DocId;
use crate::agent_journal::refusal::refusal;
use crate::agent_journal::writer::{Inner, Writer};
use crate::command_error::CommandError;

enum Begun {
    /// Answered from the request's own receipt, about this document.
    Stored(PreparedResponse, Option<DocId>),
    Refused(TxnError, Option<DocId>),
    Held(u64),
}

impl Controller {
    /// Prepare an agent write from a framed payload.
    ///
    /// # Errors
    /// The journal refusal; once the payload decodes, a request answer.
    pub fn prepare_framed(
        &self,
        pages: &PageTable,
        label: &str,
        payload: &str,
    ) -> Result<Bound<RequestBind, ControlledPrepared>, CommandError> {
        let frame = Frame::decode(payload)?;
        let req = decode_prepare(frame.body().as_bytes()).map_err(|e| refusal(&e))?;
        let request = frame.request(req.request_id)?;
        let key = req.doc_key.clone();
        let prep = controlled_prep(req).map_err(|e| refusal(&e))?;
        match self.run_framed(pages, label, &frame, &request, &key, prep)? {
            PreparedResponse::Controlled(reply) => Ok(Bound {
                bind: frame.bind(&request),
                reply,
            }),
            PreparedResponse::Restore(_) => Err(refusal(&reused_id())),
        }
    }

    /// Prepare a restore from a framed payload.
    ///
    /// # Errors
    /// As `prepare_framed`.
    pub fn restore_prepare_framed(
        &self,
        pages: &PageTable,
        label: &str,
        payload: &str,
    ) -> Result<Bound<RequestBind, RestorePrepared>, CommandError> {
        let frame = Frame::decode(payload)?;
        let req = decode_restore_prepare(frame.body().as_bytes()).map_err(|e| refusal(&e))?;
        let request = frame.request(req.request_id)?;
        let key = req.doc_key.clone();
        let prep = restore_prep(req).map_err(|e| refusal(&e))?;
        match self.run_framed(pages, label, &frame, &request, &key, prep)? {
            PreparedResponse::Restore(reply) => Ok(Bound {
                bind: frame.bind(&request),
                reply,
            }),
            PreparedResponse::Controlled(_) => Err(refusal(&reused_id())),
        }
    }

    fn run_framed(
        &self,
        pages: &PageTable,
        label: &str,
        frame: &Frame,
        request: &Request,
        key: &str,
        prep: Prep,
    ) -> Result<PreparedResponse, CommandError> {
        let w = &*self.writer;
        let owner = Owner {
            label: label.into(),
            generation: frame.generation,
        };
        let begun = begin(w, &mut w.lock(), pages, frame, request, owner.clone());
        let mut guard = match begun.map_err(|e| refusal(&e))? {
            Begun::Stored(reply, doc) => {
                self.restart_drain(doc);
                return Ok(reply);
            }
            Begun::Refused(e, doc) => {
                self.restart_drain(doc);
                return Err(refusal(&e));
            }
            Begun::Held(invocation) => RequestGuard {
                writer: w,
                id: request.id,
                invocation,
                generation: frame.generation,
                settled: false,
            },
        };
        let doc = match self.docs.resolve(key) {
            Ok(doc) => doc,
            Err(e) => {
                let mut g = w.lock();
                guard.settled = true;
                g.requests.end(request.id, guard.invocation);
                g.requests.fence(request.id, frame.generation);
                return Err(refusal(&request.refused(RequestState::NotAdmitted(e))));
            }
        };
        let out = {
            let mut g = w.lock();
            guard.settled = true;
            let attempt = Attempt {
                owner: &owner,
                frame,
                request,
                invocation: guard.invocation,
            };
            admit(w, &mut g, pages, &attempt, doc, prep)
        };
        self.settle_prepare(doc, out.is_ok());
        out.map_err(|e| refusal(&e))
    }
}

impl Controller {
    /// After an answer read from a receipt: restart the drain of its
    /// document if degraded, changing nothing else.
    pub(crate) fn restart_drain(&self, doc: Option<DocId>) {
        if let Some(doc) = doc {
            self.settle_prepare(doc, false);
        }
    }
}

/// The first critical section. See the module docs.
fn begin(
    w: &Writer,
    g: &mut Inner,
    pages: &PageTable,
    frame: &Frame,
    request: &Request,
    owner: Owner,
) -> Result<Begun, TxnError> {
    let live = || -> HashSet<u64> { pages.live_generations() };
    admit_identity(w, pages, &owner.label, frame).map_err(|s| request.refused(s))?;
    match lookup(g, request) {
        Ok(Some(stored)) => return Ok(Begun::Stored(stored, receipt_doc(g, request))),
        Err(e) => return Ok(Begun::Refused(e, receipt_doc(g, request))),
        Ok(None) => {}
    }
    g.requests
        .begin(request.id, &request.digest, owner, live)
        .map(Begun::Held)
        .map_err(|s| request.refused(s))
}

/// One attempt of a request, between its two critical sections.
struct Attempt<'a> {
    owner: &'a Owner,
    frame: &'a Frame,
    request: &'a Request,
    invocation: u64,
}

/// The second critical section: re-check, prepare, and settle the entry.
fn admit(
    w: &Writer,
    g: &mut Inner,
    pages: &PageTable,
    attempt: &Attempt<'_>,
    doc: DocId,
    prep: Prep,
) -> Result<PreparedResponse, TxnError> {
    let Attempt {
        owner,
        frame,
        request,
        invocation,
    } = *attempt;
    let id = request.id;
    if pages.liveness(&owner.label, owner.generation, &frame.identity) != Liveness::Own {
        if g.requests.holds(id, invocation) {
            g.requests.end(id, invocation);
            g.requests.fence(id, owner.generation);
        }
        return Err(request.refused(RequestState::StaleGeneration));
    }
    if !g.requests.holds(id, invocation) {
        return Err(request.refused(RequestState::Abandoned));
    }
    let out = prepare_admitted(w, g, doc, prep, Some(request.clone()));
    g.requests.end(id, invocation);
    match out {
        Ok(reply) => {
            g.requests.owners.insert(reply.txn(), owner.clone());
            Ok(reply)
        }
        Err(e @ TxnError::Request(_)) => Err(e),
        Err(e) if g.healthy().is_err() => {
            log::error!("agent journal: request {id} failed on an unhealthy writer ({e})");
            Err(request.refused(RequestState::Unavailable))
        }
        Err(e) => {
            g.requests.fence(id, owner.generation);
            Err(request.refused(RequestState::NotAdmitted(e)))
        }
    }
}
