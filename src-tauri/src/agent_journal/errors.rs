//! Structured refusals. `code()` is the wire token the MCP bridge and the
//! review panel branch on; the message is for logs.

use crate::agent_journal::admission::answer::RequestRefusal;
use crate::agent_journal::ids::{HunkId, RevisionId, TxnId};
use crate::agent_journal::provenance::Block;

/// `REVIEW_BACKLOG_FULL` is not an immediate-retry error.
pub const RETRY_AFTER_USER_REVIEW: &str = "afterUserReview";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TxnError {
    /// An unresolved transaction holds the document. Immediate refusal.
    JournalBusy { holder: TxnId },
    /// The stated parent is not the head; the current head is returned.
    StaleParent { head: Option<RevisionId> },
    /// A terminal record or capture is waiting in the in-memory queue.
    JournalDegraded,
    /// A review decision or capture effect was computed against stale state.
    StaleReview {
        hunk: Option<HunkId>,
        detail: String,
    },
    /// No hunk slot left (500 for agent changes, 600 for restores).
    ReviewBacklogFull {
        count: usize,
        limit: usize,
        retry: &'static str,
    },
    /// `reviewGen` reached a reserved value for this transition.
    ReviewStateExhausted { hunk: HunkId },
    /// The hunk's span is not certified — a break reached it (`block`,
    /// its sticky reason and origin) or two deletion anchors share an offset
    /// (`None`). Returned before `prepare` reserves anything: no record, no
    /// state, `reviewGen` or generation change. Not a record kind.
    AmbiguousRevert { hunk: HunkId, block: Option<Block> },
    /// A revert that does not apply and has no review decision to record:
    /// a conflicted hunk that conflicts again (`"conflicted"`), or a
    /// reverted hunk whose target cannot be put back (`"reapply"`).
    /// Nothing is appended.
    RevertRefused { hunk: HunkId, reason: &'static str },
    /// A bounded request table is full (in-flight requests, a label's page
    /// registrations, the generation counter). Nothing was inserted.
    Saturated(String),
    /// A commit or abort names a page registration that is no longer live.
    /// Nothing changed; owner cleanup ends the transaction.
    StalePage(String),
    /// A page registration for a window label that is not open (never
    /// opened, or destroyed): wire state `staleGeneration`, uncertain.
    StaleRegistration(String),
    /// A request-protocol answer for a decoded request id; its wire token
    /// follows its state (`admission::answer`).
    Request(Box<RequestRefusal>),
    /// The caller sent something the protocol never allows.
    InvalidRequest(String),
    /// A provenance map that does not certify what it claims (another
    /// document, no armed epoch, another basis, or texts it does not map).
    /// Wire token `INVALID_REQUEST`; the refusal names `field: provenance`
    /// so the window can resend the same request without the map, as a
    /// `snapshotOnly` barrier, instead of losing the record.
    InvalidProvenance(String),
    /// A comment anchor's quote, exact or widened to whole blocks, is over
    /// the 4,096-byte UTF-8 bound. Refused, never truncated: a shorter
    /// quote would be a different anchor.
    CommentAnchorTooLong { bytes: usize, limit: usize },
    /// Text that is not well-formed Unicode (a lone surrogate, invalid
    /// UTF-8). Refused at the boundary, never replaced with U+FFFD.
    InvalidText(String),
    /// The append did not become durable; nothing changed.
    Io(String),
    /// A prepare's write failed in a way that poisoned the journal (an
    /// fsync or truncate-back failure): the frame may or may not be
    /// durable. The live state is unchanged; reopen replays all of it or
    /// none. Wire token `JOURNAL_IO`, with `indeterminate: true`.
    Indeterminate(String),
    /// A writer invariant is broken (e.g. a capture at a reviewGen no
    /// active hunk can reach). A bug, never a user-facing refusal.
    Invariant(String),
    /// The journal cannot be read safely (not a torn tail).
    Corrupt(String),
    /// Written by a newer build; this one refuses to write on top of it.
    FutureFormat { version: u32 },
}

impl TxnError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::JournalBusy { .. } => "JOURNAL_BUSY",
            Self::StaleParent { .. } => "STALE_PARENT",
            Self::JournalDegraded => "JOURNAL_DEGRADED",
            Self::StaleReview { .. } => "STALE_REVIEW",
            Self::ReviewBacklogFull { .. } => "REVIEW_BACKLOG_FULL",
            Self::ReviewStateExhausted { .. } => "REVIEW_STATE_EXHAUSTED",
            Self::AmbiguousRevert { .. } => "AMBIGUOUS_REVERT",
            Self::RevertRefused { .. } => "REVERT_REFUSED",
            Self::Saturated(_) => "JOURNAL_BUSY",
            Self::StalePage(_) => "STALE_PAGE",
            Self::StaleRegistration(_) => "STALE_REQUEST",
            Self::Request(r) => r.state.code(),
            Self::InvalidRequest(_) | Self::InvalidProvenance(_) => "INVALID_REQUEST",
            Self::CommentAnchorTooLong { .. } => "COMMENT_ANCHOR_TOO_LONG",
            Self::InvalidText(_) => "INVALID_TEXT",
            Self::Io(_) | Self::Indeterminate(_) => "JOURNAL_IO",
            Self::Invariant(_) => "INVARIANT_BROKEN",
            Self::Corrupt(_) => "JOURNAL_CORRUPT",
            Self::FutureFormat { .. } => "JOURNAL_FUTURE_FORMAT",
        }
    }

    pub(crate) fn stale(hunk: &HunkId, detail: impl Into<String>) -> Self {
        Self::StaleReview {
            hunk: Some(hunk.clone()),
            detail: detail.into(),
        }
    }
}

impl std::fmt::Display for TxnError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {self:?}", self.code())
    }
}

impl std::error::Error for TxnError {}

impl From<std::io::Error> for TxnError {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e.to_string())
    }
}
