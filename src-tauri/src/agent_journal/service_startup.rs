//! Starting the journal off the main thread: the startup job opens the
//! journal and publishes the outcome into the managed
//! [`AgentJournalState`]; a thread that cannot spawn publishes a failure.

use super::{start, AgentJournalState};

/// Open the journal on a background thread and publish the outcome into the
/// managed [`AgentJournalState`]. Failures are logged at error level.
pub fn spawn_startup<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    spawn_startup_with(app, |run| {
        std::thread::Builder::new()
            .name("agent-journal-start".into())
            .spawn(run)
            .map(|_| ())
    });
}

/// A startup job, handed to the thread spawner.
type StartupJob = Box<dyn FnOnce() + Send>;

/// `spawn_startup` over an injectable spawner. A thread that cannot start
/// publishes a failed outcome: the status must never stay `starting`.
fn spawn_startup_with<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    spawn: impl FnOnce(StartupJob) -> std::io::Result<()>,
) {
    use tauri::Manager;
    let handle = app.clone();
    let job: StartupJob = Box::new(move || {
        let app = handle;
        let outcome = crate::app_paths::app_data_dir(&app)
            .map_err(|e| format!("JOURNAL_IO: no app-data directory: {e}"))
            .and_then(|dir| start(&dir));
        match &outcome {
            Ok(s) => {
                if let Err(e) = &s.legacy {
                    log::error!("agent journal: legacy checkpoint import failed: {e}");
                }
            }
            Err(e) => log::error!("agent journal: disabled for this session: {e}"),
        }
        if let Some(state) = app.try_state::<AgentJournalState>() {
            state.finish(outcome);
            crate::agent_journal::generation_events::spawn(
                &app,
                state.writer().as_ref(),
                state.live_updates(),
            );
        } else {
            log::error!("agent journal: state is not managed; journal unavailable");
        }
    });
    if let Err(e) = spawn(job) {
        let error = format!("JOURNAL_IO: cannot start its thread: {e}");
        log::error!("agent journal: {error}");
        match app.try_state::<AgentJournalState>() {
            Some(state) => state.finish(Err(error)),
            None => log::error!("agent journal: state is not managed; journal unavailable"),
        }
    }
}

#[cfg(all(test, not(target_os = "windows")))]
#[path = "service_startup.test.rs"]
mod tests;
