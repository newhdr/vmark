//! The capture binding of a save: a window names the provenance capture it
//! froze as `{view, session, seq}`, and the writer refuses a capture whose
//! `seq` does not extend the last one it recorded for that session. This is
//! the guard against a lost, duplicated or reordered IPC message landing a
//! stale capture after a newer one; it is a consistency check inside the
//! webview's trust (a hostile webview can already write any text), not an
//! authenticity proof.
//!
//! Key decisions:
//!   - Checked, appended and recorded in one critical section of the writer
//!     lock, so two captures of one session cannot both pass the check.
//!   - Recorded only once the observation is durable or queued (`journaled:
//!     no` lands later, in order). A save refused before its append — an
//!     unknown observed parent, a provenance map that does not certify it —
//!     records nothing, so the window may resend the same capture.
//!   - A save elided through a verified `claimsRevision` appends nothing and
//!     records no seq: the writer has proved the head already holds its text.
//!   - Keyed by session alone, not by view: the session mints the seq, so it
//!     orders every capture of that session whichever view froze it.
//!   - In memory only, never replayed. A session lives inside one webview
//!     lifetime and never outlives the process, so after a restart every
//!     capture comes from a new session and no recorded seq could apply. The
//!     minter must therefore never reuse a session id across webview
//!     incarnations (a reload mints new ones); a reused id restarting its seq
//!     is refused, which fails closed. One entry per session minted while the
//!     process runs: sessions are per tab and document key, so the map stays
//!     small for any realistic run.
//!   - Optional on the wire: a save that names no capture is unbound and not
//!     checked, which is every save until the collectors mint capture ids.
//!   - `u64::MAX` is a valid seq that nothing extends: that session is done.
//!
//! @module agent_journal/capture_seq

use std::collections::HashMap;

use serde::Deserialize;

use crate::agent_journal::errors::TxnError;
use crate::agent_journal::writer::{ObserveOutcome, ObserveRequest, Writer};

/// Longest accepted capture `view` or `session`, in UTF-8 bytes.
pub const CAPTURE_ID_MAX_BYTES: usize = 128;

/// A frozen capture's identity, validated at decode.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(try_from = "CaptureIdWire")]
pub struct CaptureId {
    pub view: String,
    pub session: String,
    pub seq: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CaptureIdWire {
    view: String,
    session: String,
    #[serde(with = "crate::agent_journal::u64_wire")]
    seq: u64,
}

impl TryFrom<CaptureIdWire> for CaptureId {
    type Error = String;

    fn try_from(w: CaptureIdWire) -> Result<Self, String> {
        for (name, value) in [("view", &w.view), ("session", &w.session)] {
            if value.is_empty() || value.len() > CAPTURE_ID_MAX_BYTES {
                return Err(format!(
                    "capture {name} must be 1..={CAPTURE_ID_MAX_BYTES} bytes"
                ));
            }
        }
        Ok(Self {
            view: w.view,
            session: w.session,
            seq: w.seq,
        })
    }
}

/// The last capture seq recorded per session, in memory (see module docs).
#[derive(Debug, Default)]
pub(crate) struct CaptureSeqs(HashMap<String, u64>);

impl CaptureSeqs {
    fn check(&self, id: &CaptureId) -> Result<(), TxnError> {
        match self.0.get(&id.session) {
            Some(&last) if id.seq <= last => Err(TxnError::InvalidRequest(format!(
                "capture seq {} does not extend the last seq {last} recorded for its session",
                id.seq
            ))),
            _ => Ok(()),
        }
    }

    fn record(&mut self, id: &CaptureId) {
        self.0.insert(id.session.clone(), id.seq);
    }
}

/// `observe_for_window`, refusing a `capture` whose seq does not extend its
/// session's before anything is written, and recording it once the
/// observation is durable or queued.
pub(crate) fn observe_bound(
    w: &Writer,
    req: ObserveRequest,
    window: &str,
    capture: Option<&CaptureId>,
) -> Result<ObserveOutcome, TxnError> {
    let mut g = w.lock();
    if let Some(id) = capture {
        g.capture_seqs.check(id)?;
    }
    let out = w.observe_in(&mut g, req, Some(window))?;
    if let Some(id) = capture {
        g.capture_seqs.record(id);
    }
    Ok(out)
}
