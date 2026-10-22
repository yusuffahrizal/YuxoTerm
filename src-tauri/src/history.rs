//! Chat history. Claude Code sessions are read straight from its own transcripts
//! in `~/.claude/projects/<project>/<session>.jsonl`, so sessions started from
//! the CLI show up too. Other agents' conversations are recorded by the app in
//! the same shape under `~/.config/yuxoterm/history/<agent>/`. Every
//! session can be resumed with its agent's own resume option.

use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

use crate::config::{config_dir, read_json, tr, write_json};

/// Transcripts can grow to many MB; summaries only scan this much.
const SUMMARY_SCAN_BYTES: u64 = 4 * 1024 * 1024;
const LIST_LIMIT: usize = 300;

#[derive(Serialize, Clone)]
pub struct SessionSummary {
    id: String,
    agent: String,
    title: String,
    cwd: String,
    /// Milliseconds since the Unix epoch.
    updated: u64,
    messages: u32,
    from_app: bool,
}

#[derive(Clone)]
struct Cached {
    mtime: SystemTime,
    title: String,
    cwd: String,
    messages: u32,
}

fn cache() -> &'static Mutex<HashMap<PathBuf, Cached>> {
    static CACHE: std::sync::OnceLock<Mutex<HashMap<PathBuf, Cached>>> = std::sync::OnceLock::new();
    CACHE.get_or_init(Default::default)
}

fn projects_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_default().join(".claude").join("projects")
}

fn app_sessions_path() -> PathBuf {
    config_dir().join("sessions.json")
}

/// Records a session started from the app, from the stream's `init` line.
pub fn remember_app_session(init_line: &str) {
    let Some(id) = serde_json::from_str::<Value>(init_line)
        .ok()
        .and_then(|v| v.get("session_id").and_then(Value::as_str).map(str::to_string))
    else {
        return;
    };
    let path = app_sessions_path();
    let mut ids: Vec<String> = read_json(&path);
    if !ids.contains(&id) {
        ids.push(id);
        let _ = write_json(&path, &ids);
    }
}

/// Text of a user message, or `None` for tool results and internal messages.
fn user_text(msg: &Value) -> Option<String> {
    let text = match msg.get("content")? {
        Value::String(s) => s.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|b| b.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => return None,
    };
    let t = text.trim_start();
    let internal = [
        "<command-",
        "<local-command",
        "<system-reminder>",
        "Caveat:",
        "[Request interrupted",
    ];
    (!t.is_empty() && !internal.iter().any(|p| t.starts_with(p))).then_some(text)
}

/// Drops the `<terminal>` context block the sidebar prepends to prompts.
fn strip_terminal_block(text: &str) -> &str {
    if text.starts_with("<terminal") {
        if let Some(end) = text.find("</terminal>") {
            return text[end + "</terminal>".len()..].trim_start();
        }
    }
    text
}

fn is_transcript_entry(v: &Value) -> bool {
    !v.get("isSidechain").and_then(Value::as_bool).unwrap_or(false)
        && !v.get("isMeta").and_then(Value::as_bool).unwrap_or(false)
}

fn summarize(path: &Path, mtime: SystemTime) -> Option<Cached> {
    let file = File::open(path).ok()?;
    let reader = BufReader::new(file);
    let mut scanned = 0u64;
    let (mut custom, mut ai, mut first_prompt, mut cwd) = (None, None, None, String::new());
    let mut messages = 0u32;
    for line in reader.lines().map_while(Result::ok) {
        scanned += line.len() as u64 + 1;
        if scanned > SUMMARY_SCAN_BYTES {
            break;
        }
        // Assistant turns and tool results are most of the bytes; skip them
        // before paying for a JSON parse.
        let interesting = line.contains("\"type\":\"user\"") && !line.contains("\"tool_result\"")
            || line.contains("-title\"")
            || line.starts_with("{\"type\":\"summary\"");
        if !interesting {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        match v.get("type").and_then(Value::as_str) {
            Some("custom-title") => custom = v.get("customTitle").and_then(Value::as_str).map(str::to_string),
            Some("ai-title") => ai = v.get("aiTitle").and_then(Value::as_str).map(str::to_string),
            Some("summary") if ai.is_none() => ai = v.get("summary").and_then(Value::as_str).map(str::to_string),
            Some("user") if is_transcript_entry(&v) => {
                if cwd.is_empty() {
                    cwd = v.get("cwd").and_then(Value::as_str).unwrap_or("").to_string();
                }
                if let Some(text) = v.get("message").and_then(user_text) {
                    messages += 1;
                    if first_prompt.is_none() {
                        first_prompt = Some(strip_terminal_block(&text).to_string());
                    }
                }
            }
            _ => {}
        }
    }
    // Sessions with no real prompt (e.g. aborted at startup) aren't worth listing.
    let first_prompt = first_prompt?;
    let title = custom.or(ai).unwrap_or_else(|| {
        let line = first_prompt.lines().next().unwrap_or("").trim();
        let mut t: String = line.chars().take(90).collect();
        if line.chars().count() > 90 {
            t.push('…');
        }
        t
    });
    Some(Cached {
        mtime,
        title,
        cwd,
        messages,
    })
}

fn app_history_dir() -> PathBuf {
    config_dir().join("history")
}

/// Transcript folders and the agent each belongs to: Claude Code's per-project
/// folders, then the app's per-agent folders.
fn transcript_dirs() -> Vec<(PathBuf, String)> {
    let mut dirs = Vec::new();
    for (root, fixed_agent) in [(projects_dir(), Some("claude")), (app_history_dir(), None)] {
        let Ok(entries) = fs::read_dir(&root) else { continue };
        for e in entries.flatten().filter(|e| e.path().is_dir()) {
            let agent = fixed_agent
                .map(str::to_string)
                .unwrap_or_else(|| e.file_name().to_string_lossy().into_owned());
            dirs.push((e.path(), agent));
        }
    }
    dirs
}

fn transcript_files() -> Vec<(PathBuf, SystemTime, String)> {
    let mut out = Vec::new();
    for (dir, agent) in transcript_dirs() {
        let Ok(files) = fs::read_dir(&dir) else { continue };
        for f in files.flatten() {
            let path = f.path();
            if path.extension().is_some_and(|e| e == "jsonl") {
                if let Ok(mtime) = f.metadata().and_then(|m| m.modified()) {
                    out.push((path, mtime, agent.clone()));
                }
            }
        }
    }
    out
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && !id.contains('/') && !id.contains("..")
}

fn find_transcript(id: &str) -> Option<(PathBuf, String)> {
    if !valid_id(id) {
        return None;
    }
    let name = format!("{id}.jsonl");
    transcript_dirs()
        .into_iter()
        .map(|(dir, agent)| (dir.join(&name), agent))
        .find(|(p, _)| p.is_file())
}

/// Appends entries (`{type: "user" | "assistant", message}`) to an app-recorded
/// conversation of a non-Claude agent.
#[tauri::command]
pub fn history_record(agent: String, session_id: String, cwd: String, entries: Vec<Value>) -> Result<(), String> {
    if agent == "claude" || !valid_id(&session_id) || !valid_id(&agent) || entries.is_empty() {
        return Ok(());
    }
    let dir = app_history_dir().join(&agent);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join(format!("{session_id}.jsonl")))
        .map_err(|e| e.to_string())?;
    use std::io::Write;
    for mut entry in entries {
        entry["cwd"] = Value::String(cwd.clone());
        entry["sessionId"] = Value::String(session_id.clone());
        writeln!(file, "{entry}").map_err(|e| e.to_string())?;
    }
    Ok(())
}

// History commands read many files, so they run off the main (UI) thread.
#[tauri::command]
pub async fn history_list(cwd: Option<String>, app_only: bool, query: Option<String>) -> Vec<SessionSummary> {
    tauri::async_runtime::spawn_blocking(move || list_sessions(cwd, app_only, query))
        .await
        .unwrap_or_default()
}

/// Fills the summary cache at startup so the first history open is instant.
pub fn prewarm() {
    list_sessions(None, false, None);
}

fn list_sessions(cwd: Option<String>, app_only: bool, query: Option<String>) -> Vec<SessionSummary> {
    let app_ids: HashSet<String> = read_json::<Vec<String>>(&app_sessions_path()).into_iter().collect();
    let query = query.unwrap_or_default().to_lowercase();
    let cwd = cwd.filter(|c| !c.is_empty());

    let mut files = transcript_files();
    files.sort_by_key(|f| std::cmp::Reverse(f.1));

    let mut out = Vec::new();
    for (path, mtime, agent) in files {
        let id = path.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string();
        let from_app = agent != "claude" || app_ids.contains(&id);
        if app_only && !from_app {
            continue;
        }
        let cached = cache().lock().unwrap().get(&path).filter(|c| c.mtime == mtime).cloned();
        let Some(info) = cached.or_else(|| {
            let s = summarize(&path, mtime)?;
            cache().lock().unwrap().insert(path.clone(), s.clone());
            Some(s)
        }) else {
            continue;
        };
        if cwd.as_ref().is_some_and(|c| &info.cwd != c) {
            continue;
        }
        if !query.is_empty() && !info.title.to_lowercase().contains(&query) && !info.cwd.to_lowercase().contains(&query)
        {
            continue;
        }
        let updated = mtime
            .duration_since(SystemTime::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        out.push(SessionSummary {
            id,
            agent,
            title: info.title,
            cwd: info.cwd,
            updated,
            messages: info.messages,
            from_app,
        });
        if out.len() >= LIST_LIMIT {
            break;
        }
    }
    out
}

#[derive(Serialize)]
pub struct SessionTranscript {
    id: String,
    agent: String,
    cwd: String,
    title: String,
    /// `{type: "user" | "assistant", message}` entries in order.
    entries: Vec<Value>,
}

#[tauri::command]
pub async fn history_load(id: String) -> Result<SessionTranscript, String> {
    tauri::async_runtime::spawn_blocking(move || load_session(id))
        .await
        .map_err(|e| e.to_string())?
}

fn load_session(id: String) -> Result<SessionTranscript, String> {
    let (path, agent) = find_transcript(&id)
        .ok_or_else(|| tr("This conversation no longer exists.", "Percakapan ini sudah tidak ada."))?;
    let file = File::open(&path).map_err(|e| e.to_string())?;
    let (mut cwd, mut title, mut first_prompt) = (String::new(), String::new(), String::new());
    let mut entries = Vec::new();
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let kind = v.get("type").and_then(Value::as_str).unwrap_or("");
        match kind {
            "custom-title" => title = v.get("customTitle").and_then(Value::as_str).unwrap_or("").into(),
            "ai-title" if title.is_empty() => title = v.get("aiTitle").and_then(Value::as_str).unwrap_or("").into(),
            "user" | "assistant" if is_transcript_entry(&v) => {
                let Some(msg) = v.get("message") else { continue };
                if cwd.is_empty() {
                    cwd = v.get("cwd").and_then(Value::as_str).unwrap_or("").into();
                }
                // Keep tool results, but drop internal user messages.
                let is_tool_result = msg.get("content").and_then(Value::as_array).is_some_and(|b| {
                    b.iter()
                        .any(|x| x.get("type").and_then(Value::as_str) == Some("tool_result"))
                });
                if kind == "user" && !is_tool_result {
                    let Some(text) = user_text(msg) else { continue };
                    if first_prompt.is_empty() {
                        first_prompt = strip_terminal_block(&text)
                            .lines()
                            .next()
                            .unwrap_or("")
                            .chars()
                            .take(90)
                            .collect();
                    }
                }
                entries.push(serde_json::json!({ "type": kind, "message": msg }));
            }
            _ => {}
        }
    }
    if title.is_empty() {
        title = first_prompt;
    }
    Ok(SessionTranscript {
        id,
        agent,
        cwd,
        title,
        entries,
    })
}

/// Moves a session's transcript (and its subagent folder, if any) to the Trash so
/// a mistaken delete can still be recovered.
#[tauri::command]
pub fn history_delete(id: String) -> Result<(), String> {
    let (path, _) = find_transcript(&id)
        .ok_or_else(|| tr("This conversation no longer exists.", "Percakapan ini sudah tidak ada."))?;
    let sidecar = path.with_extension("");
    trash(&path)?;
    if sidecar.is_dir() {
        let _ = trash(&sidecar);
    }
    cache().lock().unwrap().remove(&path);
    let ids_path = app_sessions_path();
    let mut ids: Vec<String> = read_json(&ids_path);
    if let Some(i) = ids.iter().position(|x| x == &id) {
        ids.remove(i);
        let _ = write_json(&ids_path, &ids);
    }
    Ok(())
}

/// Uses the system Trash API; never falls back to a permanent delete.
fn trash(path: &Path) -> Result<(), String> {
    trash::delete(path).map_err(|e| format!("{}: {e}", tr("Couldn't move to Trash", "Gagal memindahkan ke Sampah")))
}
