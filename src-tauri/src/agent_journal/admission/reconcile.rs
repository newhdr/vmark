//! The receipt lookup and classification of a request id already
//! receipted: an identical retry of an executable transaction gets the
//! stored reply; anything else is answered with the request's state.
//!
//! Key decisions:
//!   - The classification matches every `TxnStatus` with no wildcard, so a
//!     status added later must be classified before anything compiles.
//!   - `prepared` is never a terminal: it is executable (the writer is
//!     healthy and the transaction open), terminal-pending (its terminal is
//!     queued), unavailable (the writer is unhealthy) or abandoned (open no
//!     longer, with no terminal anywhere).
//!   - A receipt under another digest is a conflict, before any status is
//!     read: an id reused for another payload learns nothing about the
//!     first.
//!   - Every answer read from a request's own receipt (a stored reply,
//!     `terminal`, `terminalPending`, `unavailable`, `abandoned`) names
//!     the receipt's document, and its caller restarts that document's
//!     drain when it is degraded, as any refused call does
//!     (`Controller::settle_prepare`). An answer that reads no receipt of
//!     its own names no document.
//!
//! @module agent_journal/admission/reconcile

use crate::agent_journal::admission::answer::{Ended, Ending, RequestRefusal, RequestState};
use crate::agent_journal::admission::prepare::Request;
use crate::agent_journal::admission::receipt::{Outcome, PreparedResponse, Receipt};
use crate::agent_journal::errors::TxnError;
use crate::agent_journal::ids::{DocId, TxnId};
use crate::agent_journal::projection::TxnStatus;
use crate::agent_journal::record::Record;
use crate::agent_journal::writer::Inner;
use crate::agent_journal::writer_txn::open_txn;

/// What a receipted request's transaction allows a retry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Classified {
    /// Return the stored reply byte for byte.
    Executable(PreparedResponse),
    /// Refuse with this state.
    Refused(RequestState),
}

/// The stored reply for an identical retry of an executable request;
/// `None` for an id never receipted; the request's answer otherwise.
pub(crate) fn lookup(g: &Inner, r: &Request) -> Result<Option<PreparedResponse>, TxnError> {
    let Some(receipt) = g.proj.requests.get(&r.id) else {
        return Ok(None);
    };
    let state = if receipt.digest == r.digest {
        match classify(g, receipt) {
            Classified::Executable(reply) => return Ok(Some(reply)),
            Classified::Refused(state) => state,
        }
    } else {
        RequestState::Conflict
    };
    Err(r.refused(state))
}

/// The document of the transaction `r`'s receipt names, when the receipt
/// is `r`'s own (same digest): the document an answer from it is about.
pub(crate) fn receipt_doc(g: &Inner, r: &Request) -> Option<DocId> {
    let receipt = g.proj.requests.get(&r.id)?;
    if receipt.digest != r.digest {
        return None;
    }
    g.proj.txns.get(&receipt.txn()).map(|t| t.doc)
}

/// Classify `receipt`'s transaction. See the module docs.
pub(crate) fn classify(g: &Inner, receipt: &Receipt) -> Classified {
    let txn = receipt.txn();
    let Some(entry) = g.proj.txns.get(&txn) else {
        log::error!("agent journal: receipt names unknown transaction {}", txn.0);
        return Classified::Refused(RequestState::Unavailable);
    };
    let state = match entry.status {
        TxnStatus::Prepared => return prepared(g, receipt, txn),
        TxnStatus::Aborted => Ended::Aborted,
        TxnStatus::Committed => Ended::Committed,
        TxnStatus::Uncommitted => Ended::Uncommitted,
        TxnStatus::Discarded { by } => Ended::Discarded { by },
        TxnStatus::Resolved { by } => Ended::Resolved { by },
    };
    Classified::Refused(RequestState::Terminal(state))
}

fn prepared(g: &Inner, receipt: &Receipt, txn: TxnId) -> Classified {
    if let Some(queued) = queued_terminal(g, txn) {
        let ending = match queued {
            Record::Committed { .. } => Ending::Committed,
            Record::Aborted { .. } => Ending::Aborted,
            Record::Uncommitted => Ending::Uncommitted,
            other => {
                log::error!("agent journal: {} has a queued {other:?}", txn.0);
                return Classified::Refused(RequestState::Unavailable);
            }
        };
        return Classified::Refused(RequestState::TerminalPending(ending));
    }
    if g.healthy().is_err() {
        return Classified::Refused(RequestState::Unavailable);
    }
    if open_txn(g, txn).is_err() {
        return Classified::Refused(RequestState::Abandoned);
    }
    let Outcome::Prepared(reply) = &receipt.outcome;
    Classified::Executable(reply.clone())
}

/// `txn`'s queued terminal record, if one is queued.
fn queued_terminal(g: &Inner, txn: TxnId) -> Option<&Record> {
    let doc = g.proj.txns.get(&txn)?.doc;
    let q = g.degraded.get(&doc)?.iter().find(|q| q.txn == txn)?;
    Some(&q.record)
}

impl Request {
    /// This request refused in `state`.
    pub(crate) fn refused(&self, state: RequestState) -> TxnError {
        RequestRefusal::error(self.id, self.digest.clone(), state)
    }
}
