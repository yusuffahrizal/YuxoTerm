//! System clipboard access for the terminal context menu and Ctrl+Shift+C / V.
//!
//! The WebView's own clipboard API asks for permission when reading, which would pop a
//! "Paste" bubble on macOS, so reading and writing go through the platform's command-line tools.

use std::io::Write;
use std::process::{Command, Stdio};

use crate::config::tr;

/// (program, args) candidates in order of preference.
#[cfg(target_os = "macos")]
const READERS: &[(&str, &[&str])] = &[("pbpaste", &[])];
#[cfg(target_os = "macos")]
const WRITERS: &[(&str, &[&str])] = &[("pbcopy", &[])];

#[cfg(not(target_os = "macos"))]
const READERS: &[(&str, &[&str])] = &[
    ("wl-paste", &["--no-newline"]),
    ("xclip", &["-selection", "clipboard", "-o"]),
    ("xsel", &["--clipboard", "--output"]),
];
#[cfg(not(target_os = "macos"))]
const WRITERS: &[(&str, &[&str])] = &[
    ("wl-copy", &[]),
    ("xclip", &["-selection", "clipboard"]),
    ("xsel", &["--clipboard", "--input"]),
];

fn command(program: &str, args: &[&str]) -> Command {
    let mut cmd = Command::new(program);
    // Apps opened from Finder have no locale; without one pbpaste/pbcopy fall back to MacRoman.
    cmd.args(args)
        .env("LANG", "en_US.UTF-8")
        .env("PATH", crate::shellenv::login_path());
    cmd
}

fn missing_tool() -> String {
    tr(
        "No clipboard tool found (install wl-clipboard or xclip).",
        "Alat clipboard tidak ditemukan (pasang wl-clipboard atau xclip).",
    )
}

#[tauri::command]
pub async fn clipboard_read() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| {
        for (program, args) in READERS {
            if let Ok(out) = command(program, args)
                .stdin(Stdio::null())
                .stderr(Stdio::null())
                .output()
            {
                if out.status.success() {
                    return Ok(String::from_utf8_lossy(&out.stdout).into_owned());
                }
            }
        }
        Err(missing_tool())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn clipboard_write(text: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        for (program, args) in WRITERS {
            let Ok(mut child) = command(program, args)
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
            else {
                continue;
            };
            if let Some(mut stdin) = child.stdin.take() {
                let _ = stdin.write_all(text.as_bytes());
            }
            if child.wait().is_ok_and(|s| s.success()) {
                return Ok(());
            }
        }
        Err(missing_tool())
    })
    .await
    .map_err(|e| e.to_string())?
}
