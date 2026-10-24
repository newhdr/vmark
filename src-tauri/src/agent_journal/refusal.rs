//! Journal refusals as `CommandError`s. The class (`conflict`,
//! `invalid-input`, …) is what generic frontend code branches on; the exact
//! journal token rides in `detail.journalCode`, with the current head for
//! `STALE_PARENT` and `field: "provenance"` for a map that does not certify
//! its texts (the window resends without it), and `indeterminate: true`
//! for a prepare whose frame may or may not be durable. Messages are for agents and logs, never shown to a user.
//!
//! @module agent_journal/refusal

use serde_json::json;

use crate::agent_journal::errors::TxnError;
use crate::command_error::{CommandError, ErrorCode};

/// Map a writer refusal onto the command contract.
pub fn refusal(e: &TxnError) -> CommandError {
    let code = match e {
        TxnError::JournalBusy { .. }
        | TxnError::StaleParent { .. }
        | TxnError::JournalDegraded
        | TxnError::StaleReview { .. }
        | TxnError::AmbiguousRevert { .. }
        | TxnError::ReviewBacklogFull { .. }
        | TxnError::ReviewStateExhausted { .. } => ErrorCode::Conflict,
        TxnError::InvalidRequest(_) | TxnError::InvalidProvenance(_) | TxnError::InvalidText(_) => {
            ErrorCode::InvalidInput
        }
        TxnError::Io(_) | TxnError::Indeterminate(_) => ErrorCode::Io,
        TxnError::Invariant(_) | TxnError::Corrupt(_) => ErrorCode::Internal,
        TxnError::FutureFormat { .. } => ErrorCode::Unsupported,
    };
    let detail = match e {
        TxnError::StaleParent { head } => json!({ "journalCode": e.code(), "head": head }),
        TxnError::AmbiguousRevert { hunk, block } => {
            json!({ "journalCode": e.code(), "hunk": hunk, "block": block })
        }
        TxnError::InvalidProvenance(_) => json!({ "journalCode": e.code(), "field": "provenance" }),
        TxnError::Indeterminate(_) => json!({ "journalCode": e.code(), "indeterminate": true }),
        _ => json!({ "journalCode": e.code() }),
    };
    CommandError::new(code, e.to_string()).with_detail(detail)
}

/// The journal did not start (or has not finished starting).
pub fn unavailable() -> CommandError {
    CommandError::conflict("JOURNAL_UNAVAILABLE: the agent edit journal is not running")
        .with_detail(json!({ "journalCode": "JOURNAL_UNAVAILABLE" }))
}
