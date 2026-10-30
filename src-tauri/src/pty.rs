//! Pseudo-terminal management: one PTY + shell process per pane.

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

use crate::config::{self, tr, Profile};
use crate::{shellenv, sshconfig};

struct Pane {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
    /// The child is SSH or a custom command rather than a login shell, so the
    /// foreground process being the child never means "idle at a local prompt".
    direct: bool,
}

/// What to start in a pane, resolved from a profile.
#[derive(Debug, PartialEq)]
struct Launch {
    program: String,
    args: Vec<String>,
    cwd: String,
    env: Vec<(String, String)>,
    direct: bool,
}

fn words(s: &str) -> Vec<String> {
    s.split_whitespace().map(str::to_string).collect()
}

/// Turns a profile into a concrete command. `inherited_cwd` is the folder of the
/// pane the new one was opened from; it is ignored when the profile sets its own
/// folder, and for SSH, where a local folder means nothing on the remote side.
fn plan(profile: &Profile, inherited_cwd: Option<&str>) -> Result<Launch, String> {
    let home = dirs::home_dir().unwrap_or_default().display().to_string();
    let dir = |d: &str| std::path::Path::new(d).is_dir().then(|| d.to_string());
    let own_cwd = dir(profile.cwd.trim());
    let mut env: Vec<(String, String)> = Vec::new();
    let (program, args, direct, cwd) = match profile.kind.as_str() {
        "ssh" => {
            let host = profile.ssh_host.trim();
            if !sshconfig::valid_alias(host) {
                return Err(tr("Invalid SSH host.", "Host SSH tidak valid."));
            }
            let mut args = words(&profile.args);
            args.push(host.to_string());
            (shellenv::resolve_program("ssh"), args, true, own_cwd)
        }
        "command" => {
            let mut parts = words(&profile.command);
            if parts.is_empty() {
                return Err(tr("This profile has no command.", "Profil ini tidak punya perintah."));
            }
            let program = shellenv::resolve_program(&parts.remove(0));
            parts.extend(words(&profile.args));
            (program, parts, true, own_cwd.or_else(|| inherited_cwd.and_then(dir)))
        }
        _ => {
            let mut args = vec!["-l".to_string()];
            args.extend(words(&profile.args));
            (
                shellenv::user_shell(&profile.command),
                args,
                false,
                own_cwd.or_else(|| inherited_cwd.and_then(dir)),
            )
        }
    };
    if direct {
        // Not started through a login shell, so it wouldn't see the user's PATH otherwise.
        env.push(("PATH".into(), shellenv::login_path().to_string()));
    }
    env.extend(profile.env.iter().map(|(k, v)| (k.clone(), v.clone())));
    Ok(Launch {
        program,
        args,
        cwd: cwd.unwrap_or(home),
        env,
        direct,
    })
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
    profile: Option<String>,
) -> Result<(), String> {
    let cfg = config::load();
    let profile = profile.map_or_else(|| cfg.default_profile(), |id| cfg.profile(&id));
    let launch = plan(&profile, cwd.as_deref())?;
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: rows.max(2),
            cols: cols.max(2),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let mut cmd = CommandBuilder::new(&launch.program);
    cmd.args(&launch.args);
    cmd.cwd(&launch.cwd);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "YuxoTerm");
    if std::env::var("LANG").is_err() {
        cmd.env("LANG", "en_US.UTF-8");
    }
    for (k, v) in &launch.env {
        cmd.env(k, v);
    }

    let child = pair.slave.spawn_command(cmd).map_err(|e| {
        format!(
            "{} {}: {e}",
            tr("Couldn't start", "Tidak bisa menjalankan"),
            launch.program
        )
    })?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    state.panes.lock().unwrap().insert(
        id.clone(),
        Pane {
            writer,
            master: pair.master,
            child,
            direct: launch.direct,
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
    let (pgid, shell_pid, direct) = {
        let panes = state.panes.lock().unwrap();
        let Some(pane) = panes.get(&id) else { return Ok(None) };
        (pane.master.process_group_leader(), pane.child.process_id(), pane.direct)
    };
    let (Some(pgid), Some(shell_pid)) = (pgid, shell_pid) else {
        return Ok(None);
    };
    // An SSH or custom-command pane has no local prompt to be idle at.
    let shell_idle = !direct && pgid as u32 == shell_pid;
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

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(kind: &str) -> Profile {
        Profile {
            id: "p".into(),
            kind: kind.into(),
            ..Default::default()
        }
    }

    #[test]
    fn shell_profiles_start_a_login_shell_in_the_inherited_folder() {
        let launch = plan(
            &Profile {
                command: "/bin/bash".into(),
                args: "--noprofile".into(),
                ..profile("shell")
            },
            Some("/tmp"),
        )
        .unwrap();
        assert_eq!(launch.program, "/bin/bash");
        assert_eq!(launch.args, ["-l", "--noprofile"]);
        assert_eq!(launch.cwd, "/tmp");
        assert!(!launch.direct);
    }

    #[test]
    fn a_profile_folder_wins_over_the_inherited_one() {
        let launch = plan(
            &Profile {
                cwd: "/usr".into(),
                ..profile("shell")
            },
            Some("/tmp"),
        )
        .unwrap();
        assert_eq!(launch.cwd, "/usr");
    }

    #[test]
    fn ssh_puts_the_host_last_and_ignores_the_inherited_folder() {
        let launch = plan(
            &Profile {
                ssh_host: "prod".into(),
                args: "-p 2222 -A".into(),
                ..profile("ssh")
            },
            Some("/tmp"),
        )
        .unwrap();
        assert!(launch.program.ends_with("ssh"));
        assert_eq!(launch.args, ["-p", "2222", "-A", "prod"]);
        assert_ne!(launch.cwd, "/tmp");
        assert!(launch.direct);
        assert!(launch.env.iter().any(|(k, _)| k == "PATH"));
    }

    #[test]
    fn ssh_rejects_hosts_that_look_like_options() {
        for host in ["", "-oProxyCommand=x", "a b"] {
            assert!(
                plan(
                    &Profile {
                        ssh_host: host.into(),
                        ..profile("ssh")
                    },
                    None
                )
                .is_err(),
                "{host:?}"
            );
        }
    }

    #[test]
    fn command_profiles_split_the_command_line_and_need_one() {
        let launch = plan(
            &Profile {
                command: "/usr/bin/env FOO=1".into(),
                args: "bar".into(),
                ..profile("command")
            },
            None,
        )
        .unwrap();
        assert_eq!(launch.program, "/usr/bin/env");
        assert_eq!(launch.args, ["FOO=1", "bar"]);
        assert!(launch.direct);
        assert!(plan(&profile("command"), None).is_err());
    }

    #[test]
    fn profile_env_overrides_the_default_path() {
        let mut p = Profile {
            ssh_host: "h".into(),
            ..profile("ssh")
        };
        p.env.insert("PATH".into(), "/custom".into());
        let launch = plan(&p, None).unwrap();
        assert_eq!(launch.env.last().unwrap(), &("PATH".to_string(), "/custom".to_string()));
    }
}
