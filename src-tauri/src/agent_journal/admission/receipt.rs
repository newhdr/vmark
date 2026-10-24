//! A request receipt: the id a window minted for one prepare, the SHA-256
//! of the raw payload it sent, and the reply exactly as first returned.
//! Stored on the `prepared` envelope it answers (schema v3 only), so an
//! identical retry after a lost reply gets the same bytes back with no
//! second write, and a different payload under the same id is refused.
//!
//! Static binding: the stored response names the record's own document,
//! transaction and revision. A receipt anywhere else — another kind, a v1
//! or v2 envelope, an admission frame itself — is corrupt.
//!
//! @module agent_journal/admission/receipt

use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};
use sha2_v011::{Digest as _, Sha256};
use uuid::Uuid;

use crate::agent_journal::controlled_restore::RestorePrepared;
use crate::agent_journal::controlled_wire::ControlledPrepared;
use crate::agent_journal::errors::TxnError;
use crate::agent_journal::ids::{DocId, RevisionId, TxnId};
use crate::agent_journal::record::{Envelope, Record, SCHEMA_V3};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Receipt {
    pub request_id: RequestId,
    pub digest: PayloadDigest,
    pub outcome: Outcome,
}

/// What the request produced. Only `prepared` exists in schema v3; a
/// decision or comment receipt is a later schema's.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "response",
    rename_all = "camelCase",
    deny_unknown_fields
)]
pub enum Outcome {
    Prepared(PreparedResponse),
}

/// A controlled prepare's reply, or a restore's (which also carries the
/// text to apply). Told apart by their fields; both refuse unknown ones.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum PreparedResponse {
    Controlled(ControlledPrepared),
    Restore(RestorePrepared),
}

impl PreparedResponse {
    fn names(&self) -> (DocId, TxnId, RevisionId) {
        match self {
            Self::Controlled(p) => (p.doc, p.txn, p.revision),
            Self::Restore(p) => (p.doc, p.txn, p.revision),
        }
    }
}

impl Receipt {
    /// The transaction whose `prepared` stores this receipt.
    pub fn txn(&self) -> TxnId {
        let Outcome::Prepared(r) = &self.outcome;
        r.names().1
    }
}

/// A receipt is legal only on a v3 `prepared` and must name that record's
/// document, transaction and revision.
pub fn check_binding(env: &Envelope) -> Result<(), TxnError> {
    let Some(receipt) = &env.receipt else {
        return Ok(());
    };
    let Record::Prepared { doc, revision, .. } = &env.record else {
        return Err(TxnError::Corrupt(format!(
            "seq {}: a receipt on a record that is not a prepared",
            env.seq
        )));
    };
    if env.schema_version != SCHEMA_V3 {
        return Err(TxnError::Corrupt(format!(
            "seq {}: a receipt on a schema {} envelope",
            env.seq, env.schema_version
        )));
    }
    let Outcome::Prepared(response) = &receipt.outcome;
    if response.names() != (*doc, env.txn, *revision) {
        return Err(TxnError::Corrupt(format!(
            "seq {}: the receipt names another document, transaction or revision",
            env.seq
        )));
    }
    Ok(())
}

/// A window-minted request id: a lowercase, hyphenated RFC 4122 v4 UUID.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct RequestId(Uuid);

impl FromStr for RequestId {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, String> {
        let id = Uuid::parse_str(s).map_err(|e| format!("request id: {e}"))?;
        let canonical = id.hyphenated().to_string();
        if canonical != s || id.get_version_num() != 4 || id.get_variant() != uuid::Variant::RFC4122
        {
            return Err(format!("request id {s:?} is not a lowercase v4 UUID"));
        }
        Ok(Self(id))
    }
}

impl TryFrom<String> for RequestId {
    type Error = String;
    fn try_from(s: String) -> Result<Self, String> {
        s.parse()
    }
}

impl From<RequestId> for String {
    fn from(id: RequestId) -> String {
        id.to_string()
    }
}

impl fmt::Display for RequestId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.hyphenated().fmt(f)
    }
}

/// Lowercase hex SHA-256 of a request's raw payload string.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct PayloadDigest(String);

impl PayloadDigest {
    /// The digest of `payload` exactly as received, before any decoding.
    pub fn of(payload: &str) -> Self {
        let bytes = Sha256::digest(payload.as_bytes());
        Self(bytes.iter().map(|b| format!("{b:02x}")).collect())
    }
}

impl FromStr for PayloadDigest {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, String> {
        let hex = |c: u8| c.is_ascii_digit() || (b'a'..=b'f').contains(&c);
        if s.len() != 64 || !s.bytes().all(hex) {
            return Err(format!("digest {s:?} is not 64 lowercase hex digits"));
        }
        Ok(Self(s.to_owned()))
    }
}

impl TryFrom<String> for PayloadDigest {
    type Error = String;
    fn try_from(s: String) -> Result<Self, String> {
        s.parse()
    }
}

impl From<PayloadDigest> for String {
    fn from(d: PayloadDigest) -> String {
        d.0
    }
}
