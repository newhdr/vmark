//! Send a routed request to its window only while it is still live.
//!
//! "Live" is judged under the tables lock `stop_bridge` drains under, and
//! the event is emitted before that lock is released (`emit` is synchronous
//! and no Rust listener takes the lock). So a stop lands either before the
//! check — the entry is gone, nothing is sent — or after the send, when
//! stop answers "Bridge stopped" through the request's own channel. Without
//! this, a request (first send or App Nap re-send) could reach the webview
//! after shutdown and apply a mutation the client was told had failed.
//!
//! @coordinates-with mcp_bridge/server.rs — `stop_bridge` drains under the same lock
//! @coordinates-with mcp_bridge/routing.rs — the first send
//! @coordinates-with mcp_bridge/wake_retry.rs — the re-send
//! @module mcp_bridge::live_emit

use tauri::{AppHandle, Emitter, Manager, Runtime};

use super::managed::bridge;
use super::types::McpRequestEvent;

/// How a send under the tables lock ended.
#[derive(Debug)]
pub(super) enum LiveEmit {
    /// The event went to the window.
    Sent,
    /// The entry is gone: its channel already holds the answer (the
    /// webview's, or stop's "Bridge stopped"), or was dropped. Nothing sent.
    Settled,
    /// The request is pending but its client disconnected. Nothing sent.
    ClientGone,
    /// The target window does not exist. Nothing sent.
    NoWindow,
    /// The emit itself failed.
    Failed(String),
}

/// Emit `event` to `target_label` if request `event.id` is still pending
/// for connected `client_id`, deciding and sending under one lock.
pub(super) async fn emit_while_live<R: Runtime>(
    app: &AppHandle<R>,
    target_label: &str,
    event: &McpRequestEvent,
    client_id: u64,
) -> LiveEmit {
    let state = bridge(app).lock().await;
    if !state.pending.contains_key(&event.id) {
        return LiveEmit::Settled;
    }
    if !state.clients.contains_key(&client_id) {
        return LiveEmit::ClientGone;
    }
    let Some(window) = app.get_webview_window(target_label) else {
        return LiveEmit::NoWindow;
    };
    let sent = window.emit("mcp-bridge:request", event);
    drop(state);
    match sent {
        Ok(()) => LiveEmit::Sent,
        Err(e) => LiveEmit::Failed(e.to_string()),
    }
}

// Mock-runtime tests: `tauri::test` does not exist on Windows.
#[cfg(all(test, not(target_os = "windows")))]
#[path = "live_emit.test.rs"]
mod tests;
