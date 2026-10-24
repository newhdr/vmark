//! The app windows' lifecycle, as the journal writer sees it.
//!
//! A destroyed app window releases every base root its documents held and
//! tombstones its label, so a capture still in flight cannot pin a stale
//! base. A label can be built again (`main` is a fixed label the app
//! rebuilds), so a live window under the label keeps it open whichever of
//! the release and the rebuild runs first. Both are no-ops until the
//! journal is ready.

use tauri::Manager;

use super::AgentJournalState;
use crate::agent_journal::writer::Writer;

fn writer<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<std::sync::Arc<Writer>> {
    app.try_state::<AgentJournalState>()
        .and_then(|s| s.writer())
}

/// The app window `label` was destroyed: release the journal base roots
/// its documents held (`Writer::release_window_label`), then attribute any
/// unpinned overflow to the windows still open
/// (`Writer::reconcile_live_windows`). No-op until ready.
///
/// Tauri drops the destroyed window from the app before the `Destroyed`
/// handler runs, so a window found under `label` here is a rebuild that
/// was built first: its label is reopened at once, or every base it
/// registers would be refused and left collectable. Such a window cannot
/// have registered a base yet (its page runs only after the main thread
/// returns to the event loop), so releasing the label's names takes none
/// of its own.
pub fn release_window_label<R: tauri::Runtime>(app: &tauri::AppHandle<R>, label: &str) {
    if let Some(writer) = writer(app) {
        let rebuilt = app.get_webview_window(label).is_some();
        writer.release_window_label(label);
        if rebuilt {
            writer.reopen_window_label(label);
        }
        let live = app
            .webview_windows()
            .into_keys()
            .filter(|l| rebuilt || l != label)
            .collect();
        writer.reconcile_live_windows(&live);
    }
}

/// The app window `label` is about to be built again: let its new
/// documents register base roots (`Writer::reopen_window_label`). Takes
/// the writer lock and does no I/O. No-op until ready.
pub fn reopen_window_label<R: tauri::Runtime>(app: &tauri::AppHandle<R>, label: &str) {
    if let Some(writer) = writer(app) {
        writer.reopen_window_label(label);
    }
}
