//! Transactions owned by the page that prepared them: a commit or abort
//! must name that page's live pair, and a transaction whose page is gone
//! is ended by the sweep.
//!
//! Key decisions:
//!   - The ownership check runs inside the commit's (or abort's) own
//!     critical section, after the transaction is known open and before
//!     anything changes, so it linearizes at the page-table lookup made
//!     there. The table lock is taken and released inside that lookup and
//!     never held across the append.
//!   - A pair registered under no label is `STALE_PAGE`: the page is gone
//!     and the sweep ends its transaction `uncommitted`. A live pair that
//!     is not the owner's is `INVALID_REQUEST`. Neither ends the
//!     transaction: a refused owner check changes nothing.
//!   - The sweep matches every refusal of the terminal append with no
//!     wildcard; one that means a writer bug keeps the owner (the next
//!     sweep tries again) and is counted.
//!
//! @module agent_journal/admission/owned

use crate::agent_journal::admission::bound::{Bound, PairBind};
use crate::agent_journal::admission::identity::{parse_generation, PageIdentity};
use crate::agent_journal::admission::page_table::{Liveness, PageTable};
use crate::agent_journal::admission::requests::Owner;
use crate::agent_journal::controlled::{
    abort_controlled_with, commit_controlled_with, txn_doc, AbortReason, ControlledCommitted,
};
use crate::agent_journal::controller::{invalid, parse_txn, AbortReply, Controller};
use crate::agent_journal::errors::TxnError;
use crate::agent_journal::ids::{DocId, TxnId};
use crate::agent_journal::projection::TxnStatus;
use crate::agent_journal::record::Record;
use crate::agent_journal::refusal::refusal;
use crate::agent_journal::writer::{Inner, Writer};
use crate::command_error::CommandError;

/// How the sweep left a transaction whose page is gone.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OwnedEnd {
    /// `uncommitted` appended.
    Recorded,
    /// `uncommitted` queued behind a failed append.
    Queued,
    /// It had already ended.
    AlreadyTerminal,
    /// Its terminal record was already queued.
    AlreadyQueued,
    /// The writer is corrupt; the owner is kept for after a reopen.
    WriterStopped,
    /// A writer bug: the owner names something the writer cannot end.
    Invariant(OwnedBreak),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OwnedBreak {
    UnknownTxn,
    NoReservation,
    Refused(&'static str),
}

/// The page pair a commit or abort names.
struct Pair {
    identity: PageIdentity,
    generation: u64,
}

impl Pair {
    fn parse(identity: &str, generation: &str) -> Result<Self, CommandError> {
        let identity = PageIdentity::parse(identity).map_err(|e| refusal(&e))?;
        let generation = parse_generation(generation).map_err(|e| refusal(&e))?;
        Ok(Self {
            identity,
            generation,
        })
    }

    fn bind(&self, txn: TxnId) -> PairBind {
        PairBind {
            txn,
            page_identity: self.identity.to_string(),
            webview_generation: self.generation,
        }
    }

    /// Whether the page `label` names with this pair owns `txn`.
    fn authorize(
        &self,
        g: &Inner,
        pages: &PageTable,
        label: &str,
        txn: TxnId,
    ) -> Result<(), TxnError> {
        match pages.liveness(label, self.generation, &self.identity) {
            Liveness::Dead => Err(TxnError::StalePage(format!(
                "page generation {} is no longer registered",
                self.generation
            ))),
            Liveness::OtherIdentity | Liveness::OtherLabel => Err(TxnError::InvalidRequest(
                "the page pair is not the invoking window's".into(),
            )),
            Liveness::Own => {
                let owner = Owner {
                    label: label.into(),
                    generation: self.generation,
                };
                match g.requests.owners.get(&txn) {
                    Some(o) if *o == owner => Ok(()),
                    _ => Err(TxnError::InvalidRequest(
                        "the page does not own the transaction".into(),
                    )),
                }
            }
        }
    }
}

impl Controller {
    /// Commit `txn` for the page that owns it.
    ///
    /// # Errors
    /// `STALE_PAGE` for a page that is gone, `INVALID_REQUEST` for another
    /// page; the commit's refusals otherwise.
    #[allow(clippy::too_many_arguments)]
    pub fn commit_owned(
        &self,
        pages: &PageTable,
        label: &str,
        txn: &str,
        payload: &str,
        page_identity: &str,
        generation: &str,
    ) -> Result<Bound<PairBind, ControlledCommitted>, CommandError> {
        let txn = parse_txn(txn)?;
        let pair = Pair::parse(page_identity, generation)?;
        let auth = |g: &Inner| pair.authorize(g, pages, label, txn);
        let doc = txn_doc(&self.writer, txn);
        let out = commit_controlled_with(&self.writer, txn, payload.as_bytes(), Some(&auth));
        doc.inspect(|&d| self.settle(d));
        let reply = out.map_err(|e| refusal(&e))?;
        Ok(Bound {
            bind: pair.bind(txn),
            reply,
        })
    }

    /// Abort `txn` for the page that owns it, because re-verification
    /// failed.
    ///
    /// # Errors
    /// As `commit_owned`; an unknown reason is `INVALID_REQUEST`.
    pub fn abort_owned(
        &self,
        pages: &PageTable,
        label: &str,
        txn: &str,
        reason: &str,
        page_identity: &str,
        generation: &str,
    ) -> Result<Bound<PairBind, AbortReply>, CommandError> {
        let txn = parse_txn(txn)?;
        let pair = Pair::parse(page_identity, generation)?;
        let reason: AbortReason = serde_json::from_value(serde_json::json!(reason))
            .map_err(|_| invalid(&format!("unknown abort reason {reason:?}")))?;
        let auth = |g: &Inner| pair.authorize(g, pages, label, txn);
        let doc = txn_doc(&self.writer, txn);
        let out = abort_controlled_with(&self.writer, txn, reason, Some(&auth));
        doc.inspect(|&d| self.settle(d));
        let d = out.map_err(|e| refusal(&e))?;
        Ok(Bound {
            bind: pair.bind(txn),
            reply: AbortReply { durable: d.durable },
        })
    }

    /// End every owned transaction whose page generation no label holds,
    /// and drop the request state of dead generations.
    pub fn sweep(&self, pages: &PageTable) -> Vec<(TxnId, OwnedEnd)> {
        let w = &*self.writer;
        let (ended, docs) = {
            let mut g = w.lock();
            let live = pages.live_generations();
            g.requests.purge(&live);
            let mut dead: Vec<TxnId> = g
                .requests
                .owners
                .iter()
                .filter(|(_, o)| !live.contains(&o.generation))
                .map(|(t, _)| *t)
                .collect();
            dead.sort();
            let docs: Vec<DocId> = dead
                .iter()
                .filter_map(|t| g.proj.txns.get(t).map(|e| e.doc))
                .collect();
            let ended: Vec<_> = dead
                .into_iter()
                .map(|t| (t, end_owned_in(w, &mut g, t)))
                .collect();
            (ended, docs)
        };
        for doc in docs {
            self.settle(doc);
        }
        ended
    }
}

/// End `txn`, whose owner is gone, `uncommitted`. See the module docs.
pub(crate) fn end_owned_in(w: &Writer, g: &mut Inner, txn: TxnId) -> OwnedEnd {
    let broken = |g: &mut Inner, why: OwnedBreak, drop_owner: bool| {
        log::error!(
            "agent journal: cannot end owned transaction {} ({why:?})",
            txn.0
        );
        g.requests.owner_invariant_breaks += 1;
        if drop_owner {
            g.requests.owners.remove(&txn);
        }
        OwnedEnd::Invariant(why)
    };
    let Some(t) = g.proj.txns.get(&txn).cloned() else {
        return broken(g, OwnedBreak::UnknownTxn, true);
    };
    if t.status != TxnStatus::Prepared {
        g.requests.owners.remove(&txn);
        return OwnedEnd::AlreadyTerminal;
    }
    if g.degraded
        .get(&t.doc)
        .is_some_and(|q| q.iter().any(|q| q.txn == txn))
    {
        g.requests.owners.remove(&txn);
        return OwnedEnd::AlreadyQueued;
    }
    if !g.reservations.get(&t.doc).is_some_and(|r| r.txn == txn) {
        return broken(g, OwnedBreak::NoReservation, true);
    }
    match w.terminal(g, t.doc, txn, Record::Uncommitted, vec![]) {
        Ok(true) => OwnedEnd::Recorded,
        Ok(false) => OwnedEnd::Queued,
        Err(e) => match &e {
            TxnError::Corrupt(_) => OwnedEnd::WriterStopped,
            TxnError::JournalBusy { .. }
            | TxnError::StaleParent { .. }
            | TxnError::JournalDegraded
            | TxnError::StaleReview { .. }
            | TxnError::ReviewBacklogFull { .. }
            | TxnError::ReviewStateExhausted { .. }
            | TxnError::AmbiguousRevert { .. }
            | TxnError::Saturated(_)
            | TxnError::StalePage(_)
            | TxnError::StaleRegistration(_)
            | TxnError::Request(_)
            | TxnError::InvalidRequest(_)
            | TxnError::InvalidProvenance(_)
            | TxnError::InvalidText(_)
            | TxnError::Io(_)
            | TxnError::Indeterminate(_)
            | TxnError::Invariant(_)
            | TxnError::FutureFormat { .. } => broken(g, OwnedBreak::Refused(e.code()), false),
        },
    }
}
