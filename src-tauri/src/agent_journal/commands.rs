//! Tauri commands of the agent edit journal: the status query and the
//! controlled-write protocol (`prepare` → `commit` | `abort`) a window runs
//! for its agent writes, the capture of a save, the editing epochs a
//! window's provenance maps are certified under, the release of a
//! closed window's base root, and carrying a document to a new key or
//! looking one up.
//!
//! Key decisions:
//!   - `async` + `spawn_blocking`: every write fsyncs under the writer lock,
//!     which must never run on the main thread nor stall an async worker.
//!   - Payloads arrive as JSON strings, not typed arguments, so a lone
//!     surrogate escaped by `JSON.stringify` reaches the well-formed-text
//!     check and is refused as `INVALID_TEXT` instead of being replaced.
//!   - No journal (still starting, or failed to open) is a `conflict` with
//!     `journalCode: JOURNAL_UNAVAILABLE`; the caller does not write. A
//!     journal a newer build wrote refuses as `JOURNAL_FUTURE_FORMAT`.
//!
//! @module agent_journal/commands

use crate::agent_journal::capture::CaptureReply;
use crate::agent_journal::controlled::{ControlledCommitted, ControlledPrepared};
use crate::agent_journal::controller::{AbortReply, Controller, EpochReply};
use crate::agent_journal::ids::DocId;
use crate::agent_journal::service::{AgentJournalState, AgentJournalStatus};
use crate::command_error::CommandError;

/// Where the journal's startup stands: starting, ready (with generation,
/// health and the legacy import report) or failed (with the reason).
///
/// `async` so a query never runs on the main thread behind the writer lock.
///
/// # Errors
/// None today; the `Result` keeps the crate-wide command contract.
#[tauri::command]
pub async fn agent_journal_status(
    state: tauri::State<'_, AgentJournalState>,
) -> Result<AgentJournalStatus, CommandError> {
    Ok(state.status())
}

pub(super) async fn run<T: Send + 'static>(
    state: &AgentJournalState,
    f: impl FnOnce(Controller) -> Result<T, CommandError> + Send + 'static,
) -> Result<T, CommandError> {
    let c = state.controller().ok_or_else(|| state.off_refusal())?;
    tokio::task::spawn_blocking(move || f(c))
        .await
        .map_err(|e| CommandError::internal(format!("journal task failed: {e}")))?
}

/// Prepare a controlled write (`payload`: JSON `{docKey, parent, preimage,
/// actor, tool}`).
///
/// # Errors
/// A journal refusal (`detail.journalCode`), or `JOURNAL_UNAVAILABLE`.
#[tauri::command]
pub async fn agent_journal_prepare(
    state: tauri::State<'_, AgentJournalState>,
    payload: String,
) -> Result<ControlledPrepared, CommandError> {
    run(&state, move |c| c.prepare(&payload)).await
}

/// Commit an open transaction (`payload`: JSON `{postimage}`).
///
/// # Errors
/// A journal refusal; a failed append is `durable: false`, not an error.
#[tauri::command]
pub async fn agent_journal_commit(
    state: tauri::State<'_, AgentJournalState>,
    txn: String,
    payload: String,
) -> Result<ControlledCommitted, CommandError> {
    run(&state, move |c| c.commit(&txn, &payload)).await
}

/// Abort an open transaction; `reason` is `edited`, `closed`, `composing`,
/// `selection`, `applyRefused` or `timedOut`.
///
/// # Errors
/// A journal refusal; a failed append is `durable: false`, not an error.
#[tauri::command]
pub async fn agent_journal_abort(
    state: tauri::State<'_, AgentJournalState>,
    txn: String,
    reason: String,
) -> Result<AbortReply, CommandError> {
    run(&state, move |c| c.abort(&txn, &reason)).await
}

/// Record a save (`payload`: JSON `{docKey, window, observedParent,
/// postimage, initiator}`). The save itself already happened.
///
/// # Errors
/// A journal refusal; a failed append is `journaled: "no"`, not an error.
#[tauri::command]
pub async fn agent_journal_capture(
    state: tauri::State<'_, AgentJournalState>,
    payload: String,
) -> Result<CaptureReply, CommandError> {
    run(&state, move |c| c.capture(&payload)).await
}

/// Arm the next editing epoch of a document (`payload`: JSON `{docKey}`);
/// replies `{doc, epoch}` with `epoch` a decimal string.
///
/// # Errors
/// `INVALID_REQUEST` while an epoch is armed; a journal refusal otherwise.
#[tauri::command]
pub async fn agent_journal_arm_epoch(
    state: tauri::State<'_, AgentJournalState>,
    payload: String,
) -> Result<EpochReply, CommandError> {
    run(&state, move |c| c.arm_epoch(&payload)).await
}

/// Close a document's armed epoch (`payload`: JSON `{docKey, epoch}`).
///
/// # Errors
/// `INVALID_REQUEST` when `epoch` is not the armed one.
#[tauri::command]
pub async fn agent_journal_close_epoch(
    state: tauri::State<'_, AgentJournalState>,
    payload: String,
) -> Result<(), CommandError> {
    run(&state, move |c| c.close_epoch(&payload)).await
}

/// A window closed a document: release its base root (`window`:
/// `<window>/<tab>`). Idempotent.
///
/// # Errors
/// `INVALID_REQUEST` for an empty or over-long name.
#[tauri::command]
pub async fn agent_journal_release_window(
    state: tauri::State<'_, AgentJournalState>,
    window: String,
) -> Result<(), CommandError> {
    run(&state, move |c| c.release_window(&window)).await
}

/// Carry a document to a new key on Save As or in-app rename (`payload`:
/// JSON `{from, to, expectedDoc?}`; `expectedDoc` absent checks nothing,
/// `null` requires `from` to carry no document, an id requires that one).
/// Replies the document the destination carries now. Works before the
/// journal is ready.
///
/// # Errors
/// `INVALID_REQUEST` for a malformed payload or a source that no longer
/// carries `expectedDoc`; `JOURNAL_IO` when the bind cannot be made durable.
#[tauri::command]
pub async fn agent_journal_bind_document(
    app: tauri::AppHandle,
    payload: String,
) -> Result<DocId, CommandError> {
    use tauri::Manager;
    tokio::task::spawn_blocking(move || app.state::<AgentJournalState>().bind_document(&payload))
        .await
        .map_err(|e| CommandError::internal(format!("journal task failed: {e}")))?
}

/// The document a key carries, without minting one (`payload`: JSON
/// `{docKey}`); replies the id or `null`. Works before the journal is
/// ready.
///
/// # Errors
/// `INVALID_REQUEST` for a malformed payload or key.
#[tauri::command]
pub async fn agent_journal_find_document(
    app: tauri::AppHandle,
    payload: String,
) -> Result<Option<DocId>, CommandError> {
    use tauri::Manager;
    tokio::task::spawn_blocking(move || app.state::<AgentJournalState>().find_document(&payload))
        .await
        .map_err(|e| CommandError::internal(format!("journal task failed: {e}")))?
}

#[cfg(all(test, not(target_os = "windows")))]
#[path = "future_format_dispatch.test.rs"]
mod future_format_dispatch;
