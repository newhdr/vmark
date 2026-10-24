//! MCP Bridge WebSocket server: stopping it, and deciding what an envelope is.
//!
//! Bringing it UP is `start.rs` — bind, publish, refresh, spawn — which
//! moved out so its four steps could be driven on a mock app with the port
//! file and the client-token refresh injected. What is left here is the
//! teardown (`stop_bridge`, pinned in `server.test.rs`) and the ENVELOPE
//! dispatch: identify, unsupported type, a request Rust answers itself, or a
//! request that has to reach a window.
//!
//! That last one is `routed_request.rs`. `handle_message` was 232
//! lines and this file was 398 — over the ~300-line limit and holding two
//! unrelated jobs, so the routed request's ordering (register, route, emit,
//! wait, deliver) was buried inside the parse that precedes it.
//!
//! @coordinates-with mcp_bridge/connection_closed.rs — announces each drained connection
//! @coordinates-with mcp_bridge/identify.rs — the `identify` envelope
//! @coordinates-with mcp_bridge/routed_request.rs — the request that reaches a window
//! @coordinates-with peer_text.rs — how client text may be logged
//! @module mcp_bridge::server

use super::connection_closed::announce_connection_closed;
use super::delivery::{deliver_response, send_error_response};
use super::identify::handle_identify;
use super::managed::{bridge, McpBridgeState};
use super::routing::answer_rust_side;
use super::token_file::remove_port_file;
use super::types::{McpRequest, McpResponse, WsMessage};
use crate::peer_text::peer_text;
use tauri::AppHandle;
use tokio::sync::mpsc;

/// Stop the MCP bridge WebSocket server.
///
/// Generic over the runtime so the teardown — the loop signalled, every
/// client's shutdown fired, every pending request answered, the admission
/// generation bumped, every admitted Rust-side operation finished — is
/// pinned on a mock app (`server.test.rs`, `operation_lease.test.rs`).
pub async fn stop_bridge<R: tauri::Runtime>(app: &AppHandle<R>) {
    // Remove port file so MCP sidecar knows bridge is stopped
    remove_port_file(app);

    // Send shutdown signal to server loop
    let bridge = bridge(app);
    if let Some(tx) = bridge.shutdown_slot().await.take() {
        let _ = tx.send(());
    }

    // Close all client connections
    let mut guard = bridge.lock().await;

    // Invalidate in-flight handshakes FIRST (same lock the registration path
    // takes): a connection that authenticates after this drain re-checks the
    // generation and refuses to register — it must not survive shutdown.
    bridge.bump_connection_generation();

    // Shutdown all clients. Each connection's own teardown will find its
    // record gone, so the close is announced here, once per record.
    let mut closed = Vec::with_capacity(guard.clients.len());
    for (_, mut client) in guard.clients.drain() {
        if let Some(shutdown_tx) = client.shutdown.take() {
            let _ = shutdown_tx.send(());
        }
        closed.push(client.connection_id);
    }

    // Reject all pending requests
    for (_, pending) in guard.pending.drain() {
        let _ = pending.response_tx.send(McpResponse {
            success: false,
            data: None,
            error: Some("Bridge stopped".to_string()),
        });
    }
    drop(guard);
    // Rust-answered operations admitted before the drain finish first; none
    // can be admitted after it (`McpBridgeState::admit_operation`).
    bridge.await_operations().await;
    for connection_id in closed {
        announce_connection_closed(app, connection_id);
    }
}

/// The channel that writes back to `client_id`, if it is still connected.
///
/// ONE lookup. This was written out twice — once for the unsupported
/// envelope and once for a request — and the copies had drifted into two
/// missing-client policies that a reader had to diff to compare. The policies
/// still differ, and deliberately: an envelope nobody can be answered on is
/// dropped, while a request whose client has gone is reported. What they no
/// longer differ in is how the channel is FOUND; `identify`'s refusal reply
/// finds it here too.
pub(super) async fn client_sender(
    bridge: &McpBridgeState,
    client_id: u64,
) -> Option<mpsc::Sender<String>> {
    bridge
        .lock()
        .await
        .clients
        .get(&client_id)
        .map(|c| c.tx.clone())
}

/// Parse the MCP payload of a `request` envelope.
///
/// The envelope itself parsed fine, so the client message id is known — on a
/// malformed payload, answer the client with the parse error instead of
/// bubbling it up to the log-only message loop, which would leave the client
/// hanging until its own timeout.
async fn parse_request_or_reply(
    bridge: &McpBridgeState,
    msg_id: &str,
    payload: serde_json::Value,
    client_id: u64,
    client_tx: &mpsc::Sender<String>,
) -> Option<McpRequest> {
    match McpRequest::from_value(payload) {
        Ok(request) => Some(request),
        Err(e) => {
            log::warn!("[MCP Bridge] Client {client_id} sent request with invalid payload: {e}");
            send_error_response(bridge, client_id, client_tx, msg_id, &e).await;
            None
        }
    }
}

/// Handle an incoming WebSocket message.
///
/// Generic over the Tauri runtime so tests can drive the full path with
/// `tauri::test::MockRuntime`; production callers pass the default runtime.
pub(super) async fn handle_message<R: tauri::Runtime>(
    text: &str,
    client_id: u64,
    app: &AppHandle<R>,
) -> Result<(), String> {
    let bridge = bridge(app);
    let msg: WsMessage =
        serde_json::from_str(text).map_err(|e| format!("Invalid message format: {e}"))?;

    // Debug (dev only): shape and size, never text — a 256-char prefix of a
    // short insert IS the document. The two fields ARE client-chosen,
    // so they go through `peer_text`: bounded, and escaped so a newline in a
    // `type` cannot forge a log line of its own.
    #[cfg(debug_assertions)]
    log::debug!(
        "[MCP Bridge DEBUG] {} envelope id={} ({} bytes)",
        peer_text(&msg.msg_type),
        peer_text(&msg.id),
        text.len()
    );

    if msg.msg_type == "identify" {
        handle_identify(&msg.id, msg.payload, client_id, app).await;
        return Ok(());
    }

    if msg.msg_type != "request" {
        // A mistyped envelope must not hang the client until its own timeout —
        // answer with a correlated protocol error when a reply channel exists.
        if let Some(tx) = client_sender(bridge, client_id).await {
            send_error_response(
                bridge,
                client_id,
                &tx,
                &msg.id,
                &format!("Unsupported message type: {}", peer_text(&msg.msg_type)),
            )
            .await;
        }
        return Ok(());
    }

    // Fetch the client's tx channel up front — every later step (payload
    // parse failure, rust-side answer, overload, unknown window, response)
    // needs it to answer the client.
    let client_tx = client_sender(bridge, client_id)
        .await
        .ok_or("Client not found")?;

    let Some(request) =
        parse_request_or_reply(bridge, &msg.id, msg.payload, client_id, &client_tx).await
    else {
        return Ok(());
    };

    // Debug (dev only): a mutation's argument SIZE, never a value — the prefix
    // this replaces carried the inserted text itself.
    #[cfg(debug_assertions)]
    if request.request_type.starts_with("document.insert")
        || request.request_type == "selection.replace"
    {
        let bytes = serde_json::to_string(&request.args).map_or(0, |s| s.len());
        log::debug!(
            "[MCP Bridge DEBUG] {} args: {bytes} bytes",
            crate::peer_text::peer_text(&request.request_type)
        );
    }

    // Handle requests Rust answers directly (no webview) — incl. coherence
    // off-loop with the write lock. Per D2.3, delegated
    // authority binds to the principal the CONNECTION authenticated as, fixed
    // at auth time from the credential VMark issued to that AI client — not to
    // the name the client asserts in `identify`, which it may send and re-send.
    // See `principal.rs`.
    let principal = bridge.connection_principal(client_id).await;
    if let Some(response) = answer_rust_side(&request, app, principal, client_id).await {
        return deliver_response(
            bridge,
            client_id,
            &client_tx,
            msg.id,
            &response,
            "rust-side response could not be enqueued (queue full)",
        )
        .await;
    }

    super::routed_request::run(app, client_id, msg.id, request, &client_tx).await
}

#[cfg(test)]
#[path = "server.test.rs"]
mod tests;
