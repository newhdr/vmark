//! Tauri commands that carry a document to a new key (Save As, in-app
//! rename) or look up the document a key carries. Both work before the
//! journal is ready.
//!
//! Key decisions:
//!   - Same contract as `commands`: `spawn_blocking` for the durable bind,
//!     JSON string payloads, and a reply bound to the caller's `callId`.
//!
//! @module agent_journal/commands/document

use tauri::Manager;

use crate::agent_journal::admission::bound::{bind_call, Bound, CallBind};
use crate::agent_journal::ids::DocId;
use crate::agent_journal::service::AgentJournalState;
use crate::command_error::CommandError;

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
pub async fn agent_journal_bind_document<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    payload: String,
    call_id: String,
) -> Result<Bound<CallBind, DocId>, CommandError> {
    bind_call(&call_id, async move {
        tokio::task::spawn_blocking(move || app.state::<AgentJournalState>().bind_document(&payload))
            .await
            .map_err(|e| CommandError::internal(format!("journal task failed: {e}")))?
    })
    .await
}

/// The document a key carries, without minting one (`payload`: JSON
/// `{docKey}`); replies the id or `null`. Works before the journal is
/// ready.
///
/// # Errors
/// `INVALID_REQUEST` for a malformed payload or key.
#[tauri::command]
pub async fn agent_journal_find_document<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    payload: String,
    call_id: String,
) -> Result<Bound<CallBind, Option<DocId>>, CommandError> {
    bind_call(&call_id, async move {
        tokio::task::spawn_blocking(move || app.state::<AgentJournalState>().find_document(&payload))
            .await
            .map_err(|e| CommandError::internal(format!("journal task failed: {e}")))?
    })
    .await
}
