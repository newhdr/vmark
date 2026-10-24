//! The writer's read accessors: snapshots, heads, health and blob text for
//! commands, plus reservations and counters only tests read. Each takes the
//! writer lock once and copies what it returns, so no caller holds the lock.

use crate::agent_journal::errors::TxnError;
use crate::agent_journal::ids::{BlobHash, DocId, RevisionId};
use crate::agent_journal::writer::{Snapshot, Writer};

impl Writer {
    pub fn snapshot(&self) -> Snapshot {
        let g = self.lock();
        Snapshot {
            generation: g.proj.generation,
            state: g.proj.clone(),
        }
    }

    pub fn head(&self, doc: DocId) -> Option<RevisionId> {
        self.lock().proj.head(doc)
    }

    #[cfg(test)]
    pub fn reservation(&self, doc: DocId) -> Option<crate::agent_journal::writer::Reservation> {
        self.lock().reservations.get(&doc).copied()
    }

    /// The generation of the last applied record (0 for an empty journal).
    pub fn generation(&self) -> u64 {
        self.lock().proj.generation
    }

    /// `Ok` while the writer accepts controlled mutations; otherwise the
    /// refusal every one of them would get (corrupt or degraded).
    pub fn health(&self) -> Result<(), TxnError> {
        self.lock().healthy()
    }

    /// Whether any document's degraded queue holds a record: something the
    /// caller was told happened is not durable yet. Separate from `health`,
    /// which must stay `Ok` for the drainer to retry the queue.
    pub fn any_degraded_queue(&self) -> bool {
        self.lock().degraded.values().any(|q| !q.is_empty())
    }

    #[cfg(test)]
    pub fn journal_len(&self) -> u64 {
        self.lock().journal.len()
    }

    pub fn blob_text(&self, hash: &BlobHash) -> Result<String, TxnError> {
        self.lock().blobs.get(hash)
    }

    #[cfg(test)]
    pub fn pending_observations(&self, doc: DocId) -> Vec<crate::agent_journal::ids::TxnId> {
        self.lock()
            .proj
            .docs
            .get(&doc)
            .map(|d| d.pending.clone())
            .unwrap_or_default()
    }
}
