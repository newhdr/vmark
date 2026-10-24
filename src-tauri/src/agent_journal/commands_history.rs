//! Tauri commands of the history panel over the agent edit journal: prepare
//! a restore (committed or aborted through `agent_journal_commit` /
//! `agent_journal_abort`), list a document's revisions, list or discard a document's uncommitted
//! entries, and keep the panel's checkpoints (`controller_checkpoints`).
//!
//! Key decisions:
//!   - Same contract as `commands`: `async` + `spawn_blocking`, JSON string
//!     payloads, `JOURNAL_UNAVAILABLE` when no journal is open.
//!
//! @module agent_journal/commands_history

use crate::agent_journal::commands::run;
use crate::agent_journal::controlled_restore::RestorePrepared;
use crate::agent_journal::controller::AbortReply;
use crate::agent_journal::controller_checkpoints::CheckpointView;
use crate::agent_journal::controller_doc_history::DocHistory;
use crate::agent_journal::controller_history::UncommittedEntry;
use crate::agent_journal::service::AgentJournalState;
use crate::agent_journal::writer_checkpoints::ForgetReport;
use crate::command_error::CommandError;

/// Prepare a restore (`payload`: JSON `{docKey, parent, preimage, source,
/// baselineProvenance?, baselineTouched?}`); replies with the text to apply.
///
/// # Errors
/// A journal refusal (`detail.journalCode`), or `JOURNAL_UNAVAILABLE`.
#[tauri::command]
pub async fn agent_journal_restore_prepare(
    state: tauri::State<'_, AgentJournalState>,
    payload: String,
) -> Result<RestorePrepared, CommandError> {
    run(&state, move |c| c.restore_prepare(&payload)).await
}

/// A document's revisions and blocked hunks (`payload`: JSON `{docKey}`).
///
/// # Errors
/// An invalid payload or key, or `JOURNAL_UNAVAILABLE`.
#[tauri::command]
pub async fn agent_journal_history(
    state: tauri::State<'_, AgentJournalState>,
    payload: String,
) -> Result<DocHistory, CommandError> {
    run(&state, move |c| c.history(&payload)).await
}

/// A document's uncommitted entries (`payload`: JSON `{docKey}`).
///
/// # Errors
/// An invalid payload or key, or `JOURNAL_UNAVAILABLE`.
#[tauri::command]
pub async fn agent_journal_uncommitted(
    state: tauri::State<'_, AgentJournalState>,
    payload: String,
) -> Result<Vec<UncommittedEntry>, CommandError> {
    run(&state, move |c| c.uncommitted(&payload)).await
}

/// Discard one uncommitted entry (`payload`: JSON `{docKey, txn}`).
///
/// # Errors
/// `INVALID_REQUEST` when it is not that document's uncommitted entry.
#[tauri::command]
pub async fn agent_journal_discard(
    state: tauri::State<'_, AgentJournalState>,
    payload: String,
) -> Result<AbortReply, CommandError> {
    run(&state, move |c| c.discard(&payload)).await
}

/// Every checkpoint of the history panel, in the order they were written.
///
/// # Errors
/// A checkpoint's text cannot be read, or `JOURNAL_UNAVAILABLE`.
#[tauri::command]
pub async fn agent_journal_checkpoints(
    state: tauri::State<'_, AgentJournalState>,
) -> Result<Vec<CheckpointView>, CommandError> {
    run(&state, move |c| c.checkpoints()).await
}

/// Delete checkpoints (`payload`: JSON `{ids}`) from the journal.
///
/// # Errors
/// `INVALID_REQUEST` for a malformed payload, or `JOURNAL_UNAVAILABLE`.
#[tauri::command]
pub async fn agent_journal_checkpoints_forget(
    state: tauri::State<'_, AgentJournalState>,
    payload: String,
) -> Result<ForgetReport, CommandError> {
    run(&state, move |c| c.checkpoints_forget(&payload)).await
}
