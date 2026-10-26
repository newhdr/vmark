//! A controlled write's `addresses`: the comments it says it addresses,
//! checked as one set under the writer lock before the prepare.
//!
//! The set is an assertion only: it moves no thread and no `commentGen`.
//! Every failure is `INVALID_REQUEST` with `field: addresses`, naming the
//! id and why, and nothing is appended; the remedy is the same for each (list the comments again and
//! drop the id), so no failure reads as a retry with a fresh generation.
//!
//! @module agent_journal/comment/addresses

use std::collections::BTreeSet;

use crate::agent_journal::comment::book::CommentBook;
use crate::agent_journal::comment::ids::{CommentId, ThreadState};
use crate::agent_journal::errors::TxnError;
use crate::agent_journal::ids::DocId;

/// Most comments one write may address.
pub const MAX_ADDRESSES: usize = 64;

/// Refuse `ids` unless each names a distinct, retained, undeleted and
/// unresolved thread of `doc`, and there are at most `MAX_ADDRESSES`.
pub(crate) fn check(book: &CommentBook, doc: DocId, ids: &[CommentId]) -> Result<(), TxnError> {
    let refuse = |why: String| Err(TxnError::InvalidAddresses(format!("addresses: {why}")));
    if ids.len() > MAX_ADDRESSES {
        return refuse(format!("at most {MAX_ADDRESSES} comments"));
    }
    let mut seen = BTreeSet::new();
    for &id in ids {
        if !seen.insert(id) {
            return refuse(format!("comment {id} is named twice"));
        }
        match book.threads.get(&id) {
            None => return refuse(format!("no comment {id}")),
            Some(t) if t.deleted => return refuse(format!("comment {id} is deleted")),
            Some(t) if t.doc != doc => {
                return refuse(format!("comment {id} belongs to another document"))
            }
            Some(t) if t.state == ThreadState::Resolved => {
                return refuse(format!("comment {id} is resolved"))
            }
            Some(_) => {}
        }
    }
    Ok(())
}
