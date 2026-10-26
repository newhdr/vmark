//! Tauri commands of the user's comment threads: create, reply,
//! `markAddressed`, resolve, reopen, delete and the comment list. Every
//! command reaches the user handle (`Controller::comments_user`), so each
//! record they write names the `user` caller; no request field can name
//! another.
//!
//! Key decisions:
//!   - Same contract as `commands`: `async` + `spawn_blocking`, JSON string
//!     payloads, `JOURNAL_UNAVAILABLE` when no journal is open.
//!   - Create and reply are framed requests, bound to the request id and
//!     digest (`Bound<RequestBind>`); a state change, a deletion and the
//!     list echo the caller's `callId` (`Bound<CallBind>`).
//!   - The agent's family is `commands_agent`; this module is the
//!     only one that names the user handle.
//!
//! @module agent_journal/comment/commands_user

use crate::agent_journal::admission::bound::{bind_call, Bound, CallBind, RequestBind};
use crate::agent_journal::commands::run;
use crate::agent_journal::comment::list::CommentList;
use crate::agent_journal::comment::replies::{
    CommentCreatedReply, CommentDeletedReply, CommentRepliedReply, CommentStateReply,
};
use crate::agent_journal::comment::wire::StateRequest;
use crate::agent_journal::controller::decode;
use crate::agent_journal::service::AgentJournalState;
use crate::command_error::CommandError;

/// Create a thread from a frozen payload (JSON `{docKey, parent,
/// observedParent?, text, baselineProvenance?, baselineTouched?,
/// selection: {start, end, precision}, body, author, requestId,
/// incarnation, webviewGeneration, pageIdentity}`) for the invoking page;
/// replies `{bind: {requestId, digest}, reply}`.
///
/// # Errors
/// A journal refusal (`detail.journalCode`), or the off refusal.
#[tauri::command]
pub async fn comment_user_create<R: tauri::Runtime>(
    webview: tauri::Webview<R>,
    state: tauri::State<'_, AgentJournalState>,
    payload: String,
) -> Result<Bound<RequestBind, CommentCreatedReply>, CommandError> {
    let pages = state.pages().clone();
    let label = webview.label().to_owned();
    run(&state, move |c| {
        c.comments_user().create(&pages, &label, &payload)
    })
    .await
}

/// Reply to a thread from a frozen payload (JSON `{docKey, comment, body,
/// author, expectedCommentGen, requestId, incarnation, webviewGeneration,
/// pageIdentity}`); replies `{bind: {requestId, digest}, reply}`.
///
/// # Errors
/// As `comment_user_create`.
#[tauri::command]
pub async fn comment_user_reply<R: tauri::Runtime>(
    webview: tauri::Webview<R>,
    state: tauri::State<'_, AgentJournalState>,
    payload: String,
) -> Result<Bound<RequestBind, CommentRepliedReply>, CommandError> {
    let pages = state.pages().clone();
    let label = webview.label().to_owned();
    run(&state, move |c| {
        c.comments_user().reply(&pages, &label, &payload)
    })
    .await
}

/// Mark a thread addressed (`payload`: JSON `{docKey, comment,
/// expectedCommentGen}`); replies `{bind: {callId}, reply}`.
///
/// # Errors
/// A journal refusal (`detail.journalCode`), or the off refusal.
#[tauri::command]
pub async fn comment_user_mark_addressed(
    state: tauri::State<'_, AgentJournalState>,
    payload: String,
    call_id: String,
) -> Result<Bound<CallBind, CommentStateReply>, CommandError> {
    let work = run(&state, move |c| {
        let req: StateRequest = decode(&payload)?;
        c.comments_user().mark_addressed(&req)?.into_state()
    });
    bind_call(&call_id, work).await
}

/// Resolve a thread (`payload` as `comment_user_mark_addressed`).
///
/// # Errors
/// As `comment_user_mark_addressed`.
#[tauri::command]
pub async fn comment_user_resolve(
    state: tauri::State<'_, AgentJournalState>,
    payload: String,
    call_id: String,
) -> Result<Bound<CallBind, CommentStateReply>, CommandError> {
    let work = run(&state, move |c| {
        let req: StateRequest = decode(&payload)?;
        c.comments_user().resolve(&req)?.into_state()
    });
    bind_call(&call_id, work).await
}

/// Reopen a resolved thread (`payload` as `comment_user_mark_addressed`).
///
/// # Errors
/// As `comment_user_mark_addressed`.
#[tauri::command]
pub async fn comment_user_reopen(
    state: tauri::State<'_, AgentJournalState>,
    payload: String,
    call_id: String,
) -> Result<Bound<CallBind, CommentStateReply>, CommandError> {
    let work = run(&state, move |c| {
        let req: StateRequest = decode(&payload)?;
        c.comments_user().reopen(&req)?.into_state()
    });
    bind_call(&call_id, work).await
}

/// Delete a resolved thread (`payload` as `comment_user_mark_addressed`).
///
/// # Errors
/// As `comment_user_mark_addressed`.
#[tauri::command]
pub async fn comment_user_delete(
    state: tauri::State<'_, AgentJournalState>,
    payload: String,
    call_id: String,
) -> Result<Bound<CallBind, CommentDeletedReply>, CommandError> {
    let work = run(&state, move |c| {
        let req: StateRequest = decode(&payload)?;
        c.comments_user().delete(&req)?.into_deleted()
    });
    bind_call(&call_id, work).await
}

/// A document's threads against the window's text (`payload`: JSON
/// `{docKey, text}`); replies `{bind: {callId}, reply}`.
///
/// # Errors
/// An invalid payload or key, or `JOURNAL_UNAVAILABLE`.
#[tauri::command]
pub async fn comment_user_list(
    state: tauri::State<'_, AgentJournalState>,
    payload: String,
    call_id: String,
) -> Result<Bound<CallBind, CommentList>, CommandError> {
    bind_call(
        &call_id,
        run(&state, move |c| c.comments_user().list(&payload)),
    )
    .await
}

#[cfg(all(test, not(target_os = "windows")))]
#[path = "../comment_dispatch.test.rs"]
mod comment_dispatch;
