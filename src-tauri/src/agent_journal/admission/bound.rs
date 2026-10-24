//! The envelopes a framed request's success reply travels in: the reply
//! beside the arguments that bind it, so a caller can match a reply to the
//! request it sent without trusting the transport's ordering.
//!
//! Key decisions:
//!   - A prepare (agent write or restore) is bound by its request id and
//!     payload digest; a commit or abort by its transaction and the page
//!     pair it named. The generation is a canonical decimal string.
//!   - The envelope is wire-only: the persisted receipt stores the bare
//!     reply, so its bytes are unchanged.
//!
//! @module agent_journal/admission/bound

use serde::Serialize;

use crate::agent_journal::admission::answer::RequestState;
use crate::agent_journal::admission::receipt::{PayloadDigest, RequestId};
use crate::agent_journal::ids::TxnId;

/// `{bind, reply}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Bound<B, R> {
    pub bind: B,
    pub reply: R,
}

/// What binds a prepare's reply.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestBind {
    pub request_id: RequestId,
    pub digest: PayloadDigest,
}

/// What binds a commit's or abort's reply.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairBind {
    pub txn: TxnId,
    pub page_identity: String,
    #[serde(with = "crate::agent_journal::u64_wire")]
    pub webview_generation: u64,
}

/// What an abandon did, or found already done.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AbandonReply {
    /// The prepared transaction was aborted, durably.
    Aborted,
    /// Its `aborted` record is queued; the reservation holds until it lands.
    AbortQueued,
    /// The id is fenced: no attempt of it will be admitted.
    Fenced,
    /// The request had already ended (or its ending is queued).
    Ended(RequestState),
}

impl Serialize for AbandonReply {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let fields = match self {
            Self::Aborted => serde_json::json!({ "state": "aborted" }),
            Self::AbortQueued => serde_json::json!({ "state": "abortQueued" }),
            Self::Fenced => serde_json::json!({ "state": "fenced" }),
            Self::Ended(state) => serde_json::Value::Object(state.fields()),
        };
        fields.serialize(s)
    }
}
