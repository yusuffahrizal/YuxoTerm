//! Resolves the user's login environment. Apps launched from Finder get a minimal
//! PATH, so we ask the login shell once and reuse its PATH for child processes.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

const MARKER: &str = "__YUXOTERM_PATH__";

pub fn user_shell(configured: &str) -> String {
    if !configured.trim().is_empty() {
        return configured.trim().to_string();
    }
    std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into())
}

pub fn login_path() -> &'static str {
    static PATH: OnceLock<String> = OnceLock::new();
    PATH.get_or_init(|| query_login_path().unwrap_or_else(fallback_path))
}

fn query_login_path() -> Option<String> {
    let shell = user_shell("");
    let mut child = Command::new(&shell)
        .args(["-ilc", &format!("printf '\\n{MARKER}%s' \"$PATH\"")])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;

    // A broken rc file must not hang the app, so cap the wait.
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(25)),
            _ => {
                let _ = child.kill();
                return None;
            }
        }
    }
    let out = child.wait_with_output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let path = text.rsplit(MARKER).next()?.trim().to_string();
    (!path.is_empty() && text.contains(MARKER)).then_some(path)
}

fn fallback_path() -> String {
    let home = dirs::home_dir().unwrap_or_default();
    let mut parts: Vec<String> = vec![
        home.join(".local/bin").display().to_string(),
        home.join(".cargo/bin").display().to_string(),
        home.join(".bun/bin").display().to_string(),
        "/opt/homebrew/bin".into(),
        "/usr/local/bin".into(),
    ];
    if let Ok(p) = std::env::var("PATH") {
        parts.push(p);
    }
    parts.join(":")
}

/// Finds an executable by name on the login PATH.
pub fn which(name: &str) -> Option<PathBuf> {
    login_path()
        .split(':')
        .map(|dir| Path::new(dir).join(name))
        .find(|p| is_executable(p))
}

fn is_executable(p: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        p.metadata()
            .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        p.is_file()
    }
}
