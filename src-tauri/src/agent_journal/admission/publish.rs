//! Publishing a staged prepare: the one place its outcome is decided.
//!
//! | Event | Outcome |
//! |---|---|
//! | the writer cannot persist, a blob put fails, a write error the file truncates back | refused: journal, projection, reservations and events unchanged |
//! | an fsync or truncate-back failure that poisons the journal | indeterminate (`JOURNAL_IO`, `indeterminate`): the frame may or may not be durable; the live state is unchanged and the writer refuses writes until reopen, which replays the whole frame or none of it |
//! | the frame is durable | the staged projection (or the record applied) becomes live, the reservation is taken (a `prepared` outcome only; a review decision holds none), one `Appended` per record |
//!
//! Staged blobs are stored before the frame, so a durable frame never
//! names a missing text; a refused frame may leave unreferenced blobs,
//! which collection drops.
//!
//! @module agent_journal/admission/publish

use crate::agent_journal::admission::receipt::Outcome;
use crate::agent_journal::codec;
use crate::agent_journal::errors::TxnError;
use crate::agent_journal::ids::{BlobHash, DocId, TxnId};
use crate::agent_journal::projection::Projection;
use crate::agent_journal::record::{Envelope, Record};
use crate::agent_journal::writer::certificate::FallbackReason;
use crate::agent_journal::writer::{Inner, JournalEvent, Reservation, Writer};

/// A prepare built in full, waiting to be written.
pub(crate) struct Staging {
    /// The top-level record, or the `admission` frame.
    pub(crate) env: Envelope,
    /// Texts the envelope names that the pack does not hold yet.
    pub(crate) blobs: Vec<(BlobHash, String)>,
    /// The clone every item was applied to; `None` for a single record,
    /// applied to the live projection once durable.
    pub(crate) staged: Option<Projection>,
    pub(crate) doc: DocId,
    /// The transaction a `prepared` opens, or the decision record's.
    pub(crate) txn: TxnId,
    pub(crate) response: Outcome,
    pub(crate) fallback: Option<FallbackReason>,
}

impl Writer {
    /// Write `s` and make it live. See the module docs for the outcomes.
    pub(crate) fn publish(&self, g: &mut Inner, s: Staging) -> Result<(), TxnError> {
        let out = self.publish_unannounced(g, s);
        if out.is_err() {
            self.broadcast(JournalEvent::HealthChanged);
        }
        out
    }

    fn publish_unannounced(&self, g: &mut Inner, s: Staging) -> Result<(), TxnError> {
        g.persistable()?;
        for (hash, text) in &s.blobs {
            g.blobs.put(hash, text)?;
        }
        self.faults.run_hook(&s.env);
        if let Err(e) = g.journal.append(&codec::encode(&s.env)) {
            return Err(if g.journal.is_poisoned() {
                TxnError::Indeterminate(e.to_string())
            } else {
                e
            });
        }
        match s.staged {
            Some(proj) => g.proj = proj,
            None => {
                if let Err(e) = g.proj.apply(&s.env) {
                    // Preflighted before the write, so this is a writer bug.
                    g.journal.poison();
                    return Err(TxnError::Corrupt(format!(
                        "appended record failed to apply: {e}"
                    )));
                }
            }
        }
        if let Outcome::Prepared(_) = &s.response {
            g.reservations.insert(s.doc, Reservation { txn: s.txn });
        }
        let records = match s.env.record {
            Record::Admission { items } => items,
            _ => vec![s.env],
        };
        for env in records {
            self.broadcast(JournalEvent::Appended(Box::new(env)));
        }
        Ok(())
    }
}
