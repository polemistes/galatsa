// SPDX-License-Identifier: GPL-3.0-or-later

//! Desktop shell prototype: shows the benchmark pages in the system's web view and
//! gives them what a page cannot do itself: sample the memory of the whole
//! program, describe the machine, and save results to a folder.
//!
//! Results go to <Documents>/Galatsa-maaling/<session>/, where a session is one
//! press of a start button. Environment variables, for automated runs:
//!   GALATSA_RESULTS_DIR      results root instead of <Documents>/Galatsa-maaling
//!   GALATSA_PLATFORM_LABEL   label in folder and file names instead of the OS name
//!   GALATSA_AUTORUN          "all" or an engine id: start at once
//!   GALATSA_EXIT_WHEN_DONE   "1": quit when the runs are finished

mod host;
mod memory;

use serde::Serialize;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, State};

type SharedSampler = Arc<Mutex<memory::Sampler>>;

fn env(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|v| !v.trim().is_empty())
}

/// Letters, digits, dot, dash and underscore; not starting with a dot. Keeps every
/// name the page sends inside the results folder.
fn safe_name(name: &str) -> Result<&str, String> {
    let ok = !name.is_empty()
        && name.len() <= 200
        && !name.starts_with('.')
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'));
    if ok {
        Ok(name)
    } else {
        Err(format!("invalid name: {name:?}"))
    }
}

fn platform_label() -> String {
    env("GALATSA_PLATFORM_LABEL")
        .and_then(|l| safe_name(&l).ok().map(str::to_string))
        .unwrap_or_else(|| std::env::consts::OS.to_string())
}

fn results_root(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(dir) = env("GALATSA_RESULTS_DIR") {
        return Ok(PathBuf::from(dir));
    }
    let base = app
        .path()
        .document_dir()
        .or_else(|_| app.path().home_dir())
        .map_err(|e| e.to_string())?;
    Ok(base.join("Galatsa-maaling"))
}

fn session_dir(app: &AppHandle, session: &str) -> Result<PathBuf, String> {
    Ok(results_root(app)?.join(safe_name(session)?))
}

#[tauri::command]
fn memory_source() -> &'static str {
    memory::SOURCE
}

/// Runs off the main thread: the page calls it every 250 ms during a run, and the
/// main thread of the app must stay free for the web view.
#[tauri::command]
async fn memory_sample(sampler: State<'_, SharedSampler>) -> Result<memory::MemorySample, String> {
    let sampler = Arc::clone(&sampler);
    tauri::async_runtime::spawn_blocking(move || {
        let mut sampler = sampler.lock().map_err(|e| e.to_string())?;
        Ok(sampler.sample())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn host_info() -> Result<host::HostInfo, String> {
    tauri::async_runtime::spawn_blocking(host::collect)
        .await
        .map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    platform: String,
    results_root: String,
    autorun: Option<String>,
    exit_when_done: bool,
}

#[tauri::command]
fn settings(app: AppHandle) -> Result<Settings, String> {
    Ok(Settings {
        platform: platform_label(),
        results_root: results_root(&app)?.to_string_lossy().into_owned(),
        autorun: env("GALATSA_AUTORUN"),
        exit_when_done: env("GALATSA_EXIT_WHEN_DONE").as_deref() == Some("1"),
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Session {
    /// Folder name, used to address the session in the other commands.
    id: String,
    path: String,
}

/// Creates <root>/<stamp>_<platform>/. The stamp (local date and time) comes from
/// the page; a number is added if the folder exists.
#[tauri::command]
fn start_session(app: AppHandle, stamp: String) -> Result<Session, String> {
    let root = results_root(&app)?;
    let base = format!("{}_{}", safe_name(&stamp)?, platform_label());
    for n in 1..1000 {
        let id = if n == 1 {
            base.clone()
        } else {
            format!("{base}-{n}")
        };
        let path = root.join(&id);
        if path.exists() {
            continue;
        }
        std::fs::create_dir_all(&path).map_err(|e| format!("{}: {e}", path.display()))?;
        return Ok(Session {
            id,
            path: path.to_string_lossy().into_owned(),
        });
    }
    Err("too many sessions with the same time".into())
}

#[tauri::command]
fn session_path(app: AppHandle, session: String) -> Result<String, String> {
    Ok(session_dir(&app, &session)?.to_string_lossy().into_owned())
}

#[tauri::command]
fn save_text(app: AppHandle, session: String, name: String, text: String) -> Result<(), String> {
    let path = session_dir(&app, &session)?.join(safe_name(&name)?);
    std::fs::write(&path, text).map_err(|e| format!("{}: {e}", path.display()))
}

/// Binary file (a capture image) as the raw request body, with the session and the
/// file name in the headers "galatsa-session" and "galatsa-name".
#[tauri::command]
fn save_binary(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let header = |key: &str| {
        request
            .headers()
            .get(key)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string)
            .ok_or_else(|| format!("missing header {key}"))
    };
    let session = header("galatsa-session")?;
    let name = header("galatsa-name")?;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected a raw body".into());
    };
    let path = session_dir(&app, &session)?.join(safe_name(&name)?);
    std::fs::write(&path, bytes).map_err(|e| format!("{}: {e}", path.display()))
}

#[tauri::command]
fn read_text(app: AppHandle, session: String, name: String) -> Result<Option<String>, String> {
    let path = session_dir(&app, &session)?.join(safe_name(&name)?);
    match std::fs::read_to_string(&path) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("{}: {e}", path.display())),
    }
}

/// Opens the session folder (or the results root) in the file manager.
#[tauri::command]
fn open_folder(app: AppHandle, session: Option<String>) -> Result<(), String> {
    let path = match session {
        Some(s) => session_dir(&app, &s)?,
        None => results_root(&app)?,
    };
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    let program = if cfg!(target_os = "windows") {
        "explorer"
    } else if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    std::process::Command::new(program)
        .arg(&path)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("{program}: {e}"))
}

#[tauri::command]
fn exit_app(app: AppHandle, code: i32) {
    app.exit(code);
}

pub fn run() {
    tauri::Builder::default()
        .manage::<SharedSampler>(Arc::new(Mutex::new(memory::Sampler::new())))
        .invoke_handler(tauri::generate_handler![
            memory_source,
            memory_sample,
            host_info,
            settings,
            start_session,
            session_path,
            save_text,
            save_binary,
            read_text,
            open_folder,
            exit_app,
        ])
        .run(tauri::generate_context!())
        .expect("error while running the Galatsa measurement app");
}

#[cfg(test)]
mod tests {
    use super::safe_name;

    #[test]
    fn names_stay_inside_the_folder() {
        assert!(safe_name("linux-konva-1-capture.json").is_ok());
        assert!(safe_name("2026-11-26_18-30-00_linux").is_ok());
        for bad in ["", "..", ".hidden", "a/b", "a\\b", "C:x", "æ.json", "a b"] {
            assert!(safe_name(bad).is_err(), "{bad:?} should be refused");
        }
    }
}
