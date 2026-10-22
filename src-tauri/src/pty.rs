//! Pseudo-terminal management: one PTY + shell process per pane.

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

use crate::{config, shellenv};

struct Pane {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Default)]
pub struct PtyState {
    panes: Mutex<HashMap<String, Pane>>,
}

#[derive(Serialize, Clone)]
struct PtyOutput<'a> {
    id: &'a str,
    data: String,
}

#[tauri::command]
pub fn pty_spawn(
    app: AppHandle,
    state: State<PtyState>,
    id: String,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let cfg = config::load();
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: rows.max(2),
            cols: cols.max(2),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let shell = shellenv::user_shell(&cfg.shell);
    let mut cmd = CommandBuilder::new(&shell);
    cmd.arg("-l");
    let home = dirs::home_dir().unwrap_or_default();
    let dir = cwd
        .filter(|d| std::path::Path::new(d).is_dir())
        .unwrap_or_else(|| home.display().to_string());
    cmd.cwd(dir);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "YuxoTerm");
    if std::env::var("LANG").is_err() {
        cmd.env("LANG", "en_US.UTF-8");
    }

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    state.panes.lock().unwrap().insert(
        id.clone(),
        Pane {
            writer,
            master: pair.master,
            child,
        },
    );

    std::thread::spawn(move || {
        let mut buf = vec![0u8; 64 * 1024];
        let mut pending: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    pending.extend_from_slice(&buf[..n]);
                    let data = take_utf8(&mut pending);
                    if !data.is_empty() {
                        let _ = app.emit("pty-output", PtyOutput { id: &id, data });
                    }
                }
            }
        }
        let _ = app.emit("pty-exit", id);
    });
    Ok(())
}

/// Drains the longest valid UTF-8 prefix, keeping an incomplete trailing
/// sequence for the next read so multi-byte characters are never split.
fn take_utf8(pending: &mut Vec<u8>) -> String {
    match std::str::from_utf8(pending) {
        Ok(s) => {
            let out = s.to_owned();
            pending.clear();
            out
        }
        Err(e) if e.error_len().is_none() => {
            let valid = e.valid_up_to();
            let out = String::from_utf8_lossy(&pending[..valid]).into_owned();
            pending.drain(..valid);
            out
        }
        Err(_) => {
            let out = String::from_utf8_lossy(pending).into_owned();
            pending.clear();
            out
        }
    }
}

#[tauri::command]
pub fn pty_write(state: State<PtyState>, id: String, data: String) -> Result<(), String> {
    let mut panes = state.panes.lock().unwrap();
    let pane = panes.get_mut(&id).ok_or("no such pane")?;
    pane.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    pane.writer.flush().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_resize(state: State<PtyState>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    let panes = state.panes.lock().unwrap();
    let pane = panes.get(&id).ok_or("no such pane")?;
    pane.master
        .resize(PtySize {
            rows: rows.max(2),
            cols: cols.max(2),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_kill(state: State<PtyState>, id: String) {
    if let Some(mut pane) = state.panes.lock().unwrap().remove(&id) {
        let _ = pane.child.kill();
    }
}

/// Current working directory of the pane's shell, used to scope Claude sessions.
/// Async because `lsof` takes tens of milliseconds and would stall the UI thread.
#[tauri::command]
pub async fn pty_cwd(state: State<'_, PtyState>, id: String) -> Result<Option<String>, ()> {
    let Some(pid) = state.panes.lock().unwrap().get(&id).and_then(|p| p.child.process_id()) else {
        return Ok(None);
    };
    Ok(tauri::async_runtime::spawn_blocking(move || process_cwd(pid))
        .await
        .ok()
        .flatten())
}

#[derive(Serialize)]
pub struct Foreground {
    /// Name of the process group currently owning the terminal.
    name: String,
    /// True when the shell itself is in the foreground, i.e. at its prompt.
    shell_idle: bool,
}

/// What is running in the pane right now, used by the agent tools to tell a
/// finished command from a long-running one or an interactive session.
#[tauri::command]
pub async fn pty_foreground(state: State<'_, PtyState>, id: String) -> Result<Option<Foreground>, ()> {
    let (pgid, shell_pid) = {
        let panes = state.panes.lock().unwrap();
        let Some(pane) = panes.get(&id) else { return Ok(None) };
        (pane.master.process_group_leader(), pane.child.process_id())
    };
    let (Some(pgid), Some(shell_pid)) = (pgid, shell_pid) else {
        return Ok(None);
    };
    let shell_idle = pgid as u32 == shell_pid;
    let name = tauri::async_runtime::spawn_blocking(move || process_name(pgid as u32))
        .await
        .ok()
        .flatten();
    Ok(Some(Foreground {
        name: name.unwrap_or_default(),
        shell_idle,
    }))
}

fn process_name(pid: u32) -> Option<String> {
    let out = std::process::Command::new("ps")
        .args(["-o", "comm=", "-p", &pid.to_string()])
        .output()
        .ok()?;
    let comm = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let base = comm
        .rsplit('/')
        .next()
        .unwrap_or(&comm)
        .trim_start_matches('-')
        .to_string();
    (!base.is_empty()).then_some(base)
}

#[cfg(target_os = "macos")]
fn process_cwd(pid: u32) -> Option<String> {
    let out = std::process::Command::new("/usr/sbin/lsof")
        .args(["-a", "-p", &pid.to_string(), "-d", "cwd", "-Fn"])
        .output()
        .ok()?;
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .find_map(|l| l.strip_prefix('n').map(str::to_string))
}

#[cfg(target_os = "linux")]
fn process_cwd(pid: u32) -> Option<String> {
    std::fs::read_link(format!("/proc/{pid}/cwd"))
        .ok()
        .map(|p| p.display().to_string())
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn process_cwd(_pid: u32) -> Option<String> {
    None
}
