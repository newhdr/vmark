//! The wire shapes of `document.write`'s controlled-mutation protocol: the
//! prepare and commit requests a window sends, the answers it receives, and
//! the reasons its re-verification may abort with. Decoding checks the text
//! first (`INVALID_TEXT`), then the shape, an MCP actor and a bounded tool
//! name (`INVALID_REQUEST`). The protocol itself lives in `controlled`.
//!
//! @module agent_journal/controlled_wire

use serde::{Deserialize, Serialize};

use crate::agent_journal::actor::Actor;
use crate::agent_journal::errors::TxnError;
use crate::agent_journal::ids::{DocId, RevisionId, TxnId};
use crate::agent_journal::provenance_field::ProvenanceField;

/// Longest accepted tool name, in bytes.
pub const TOOL_MAX_BYTES: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ControlledPrepareRequest {
    pub doc_key: String,
    /// The revision this window last learned from the journal; `None` when
    /// it never wrote through the journal (no CAS then).
    #[serde(default)]
    pub parent: Option<RevisionId>,
    /// The window's current buffer text.
    pub preimage: String,
    pub actor: Actor,
    pub tool: String,
    /// The certified map from the head text to `preimage`, flushed from
    /// the window's unsaved edits. `None`: the baseline is snapshot-only.
    #[serde(default)]
    pub baseline_provenance: Option<ProvenanceField>,
    /// The window says a person touched the buffer since its journaled
    /// text, even if the text is equal again: an equal-text baseline is
    /// then still recorded (as a `snapshotOnly` barrier without a map).
    #[serde(default)]
    pub baseline_touched: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlledPrepared {
    pub doc: DocId,
    pub txn: TxnId,
    pub revision: RevisionId,
    #[serde(with = "crate::agent_journal::u64_wire")]
    pub generation: u64,
    /// The human revision recorded for unjournaled buffer text, if any.
    pub baseline: Option<RevisionId>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ControlledCommitRequest {
    pub(crate) postimage: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlledCommitted {
    pub doc: DocId,
    pub revision: RevisionId,
    pub applied: bool,
    pub durable: bool,
}

/// Why the window aborted the transaction: its re-verification refused to
/// apply, or (`TimedOut`) its prepare answered after the window gave up.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AbortReason {
    /// The buffer changed after the prepare.
    Edited,
    /// The tab closed.
    Closed,
    /// An IME composition is in progress.
    Composing,
    /// The selection or target moved.
    Selection,
    /// The editor refused the apply itself.
    ApplyRefused,
    /// The prepare answered after the window's deadline; nothing was applied
    /// and the editor refused nothing.
    TimedOut,
}

impl AbortReason {
    /// The text of the `aborted` record. A re-verification refusal reads
    /// `reverify:<reason>`; a timeout carries no such prefix, because the
    /// editor refused nothing.
    pub fn record_text(self) -> String {
        let wire = serde_json::to_value(self)
            .ok()
            .and_then(|v| v.as_str().map(str::to_owned))
            .unwrap_or_default();
        match self {
            Self::TimedOut => wire,
            _ => format!("reverify:{wire}"),
        }
    }
}

/// Text first, then shape: the one checked decoder, under its local name.
pub(crate) use crate::agent_journal::wire::decode_json as decode;

/// Decode a prepare payload: well-formed text first (`INVALID_TEXT`), then
/// shape, an MCP actor and a bounded tool name (`INVALID_REQUEST`).
pub fn decode_prepare(payload: &[u8]) -> Result<ControlledPrepareRequest, TxnError> {
    let req: ControlledPrepareRequest = decode(payload)?;
    if !matches!(req.actor, Actor::Mcp { .. }) {
        return Err(TxnError::InvalidRequest(
            "a controlled write is attributed to an MCP actor".into(),
        ));
    }
    if req.tool.is_empty() || req.tool.len() > TOOL_MAX_BYTES {
        return Err(TxnError::InvalidRequest(format!(
            "tool must be 1..={TOOL_MAX_BYTES} bytes"
        )));
    }
    Ok(req)
}
