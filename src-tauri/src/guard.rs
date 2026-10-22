//! Centralized command guard.
//!
//! Rules live in `~/.config/yuxoterm/guard.json` and are enforced through a
//! Claude Code `PreToolUse` hook that runs this same binary with `--guard-hook`.
//! Every Claude session started by the app gets the hook; it can also be installed
//! into `~/.claude/settings.json` so plain `claude` sessions obey the same rules.
//!
//! An `ask` decision is forwarded over a Unix socket to the running app, which shows
//! an approval dialog. Without the app (e.g. a plain `claude` session) the hook
//! returns `ask` and Claude Code prompts in its own UI instead.

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

use crate::config::{config_dir, read_json, tr, write_json};

pub const SOCK_ENV: &str = "YUXOTERM_SOCK";
/// MCP server name for the terminal-control tools (see `mcp.rs`).
pub const TERM_SERVER: &str = "yuxoterm";
/// Server name used before the project was renamed to YuxoTerm.
pub const LEGACY_TERM_SERVER: &str = "agentic_terminal";
const HOOK_FLAG: &str = "--guard-hook";

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Action {
    Allow,
    Ask,
    Deny,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Rule {
    pub name: String,
    /// Regex matched against the tool name, e.g. `Bash` or `Write|Edit`.
    pub tool: String,
    /// Regex matched against the tool's subject (command, file path, URL…).
    pub pattern: String,
    pub action: Action,
    #[serde(default = "yes")]
    pub enabled: bool,
}

fn yes() -> bool {
    true
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct GuardConfig {
    pub enabled: bool,
    pub default_action: Action,
    pub ask_timeout_secs: u64,
    /// Evaluated top to bottom; the first matching rule wins.
    pub rules: Vec<Rule>,
}

impl Default for GuardConfig {
    fn default() -> Self {
        let r = |name: &str, tool: &str, pattern: &str, action| Rule {
            name: name.into(),
            tool: tool.into(),
            pattern: pattern.into(),
            action,
            enabled: true,
        };
        Self {
            enabled: true,
            default_action: Action::Allow,
            ask_timeout_secs: 300,
            rules: vec![
                r(
                    "Delete root or home folder",
                    "Bash",
                    r"\brm\s+(-[a-zA-Z]*\s+)*(/|~|\$HOME)/?(\s|$|\*)",
                    Action::Deny,
                ),
                r(
                    "Format or overwrite a disk",
                    "Bash",
                    r"\b(mkfs(\.\w+)?|diskutil\s+(erase\w*|partition\w*)|dd\s+.*of=/dev/)",
                    Action::Deny,
                ),
                r("Fork bomb", "Bash", r":\(\)\s*\{\s*:\|:&\s*\};:", Action::Deny),
                r(
                    "Shut down or restart",
                    "Bash",
                    r"\b(shutdown|reboot|halt)\b",
                    Action::Deny,
                ),
                r("Modify SSH keys", "Write|Edit|MultiEdit", r"/\.ssh/", Action::Deny),
                r(
                    "Run as administrator (sudo)",
                    "Bash",
                    r"(^|[;&|]\s*)sudo\b",
                    Action::Ask,
                ),
                r(
                    "Delete folders recursively",
                    "Bash",
                    r"\brm\s+-[a-zA-Z]*[rR]",
                    Action::Ask,
                ),
                r(
                    "Push or reset Git history",
                    "Bash",
                    r"\bgit\s+(push|reset\s+--hard|clean\s+-[a-z]*f)",
                    Action::Ask,
                ),
                r(
                    "Run a script from the internet",
                    "Bash",
                    r"\b(curl|wget)\b.*\|\s*(sudo\s+)?(ba|z)?sh\b",
                    Action::Ask,
                ),
                r(
                    "Publish a package",
                    "Bash",
                    r"\b(npm|pnpm|yarn|cargo)\s+publish\b",
                    Action::Ask,
                ),
                r(
                    "Destructive kubectl or Terraform",
                    "Bash",
                    r"\b(kubectl\s+delete|terraform\s+(apply|destroy))\b",
                    Action::Ask,
                ),
                r(
                    "Destructive SQL",
                    ".*",
                    r"(?i)\b(drop\s+(table|database|schema)|truncate\s+table)\b",
                    Action::Ask,
                ),
                r(
                    "Make files world-writable",
                    "Bash",
                    r"\bchmod\s+-R\s+0?777\b",
                    Action::Ask,
                ),
            ],
        }
    }
}

pub fn guard_path() -> PathBuf {
    config_dir().join("guard.json")
}

fn log_path() -> PathBuf {
    config_dir().join("guard.log")
}

pub fn load() -> GuardConfig {
    let path = guard_path();
    if !path.exists() {
        let cfg = GuardConfig::default();
        let _ = write_json(&path, &cfg);
        return cfg;
    }
    let mut cfg: GuardConfig = read_json(&path);
    if migrate_rule_names(&mut cfg) {
        let _ = write_json(&path, &cfg);
    }
    cfg
}

/// Built-in rules were first shipped with Indonesian names; the UI now
/// translates the English names, so rename untouched ones.
fn migrate_rule_names(cfg: &mut GuardConfig) -> bool {
    const RENAMES: [(&str, &str); 12] = [
        ("Hapus root / home", "Delete root or home folder"),
        ("Format / tulis disk", "Format or overwrite a disk"),
        ("Shutdown / reboot", "Shut down or restart"),
        ("Ubah kunci SSH", "Modify SSH keys"),
        ("sudo", "Run as administrator (sudo)"),
        ("rm rekursif", "Delete folders recursively"),
        ("git push / reset keras", "Push or reset Git history"),
        ("Pipe skrip dari internet", "Run a script from the internet"),
        ("Publish paket", "Publish a package"),
        ("kubectl / terraform destruktif", "Destructive kubectl or Terraform"),
        ("SQL destruktif", "Destructive SQL"),
        ("chmod 777 rekursif", "Make files world-writable"),
    ];
    let mut changed = false;
    for rule in &mut cfg.rules {
        if let Some((_, new)) = RENAMES.iter().find(|(old, _)| *old == rule.name) {
            rule.name = new.to_string();
            changed = true;
        }
    }
    changed
}

/// Terminal-control tools type into a real shell, so `Bash` rules apply to them too.
/// Maps each agent's tool names onto the Claude Code names rules are written
/// against, so one `Bash` rule covers Codex, Gemini CLI, OpenCode and the
/// terminal tools too.
fn rule_tool_name(tool: &str) -> &str {
    // The terminal tools type into a real shell. MCP tool names vary by agent:
    // mcp__yuxoterm__run_command, yuxoterm_run_command, … (and the pre-rename
    // `agentic_terminal` server name).
    let terminal_tool = tool.contains(TERM_SERVER) || tool.contains(LEGACY_TERM_SERVER);
    if terminal_tool && (tool.ends_with("run_command") || tool.ends_with("send_keys")) {
        return "Bash";
    }
    match tool {
        "bash" | "shell" | "Shell" | "exec_command" | "run_shell_command" | "local_shell" => "Bash",
        "write" | "write_file" | "create_file" => "Write",
        "edit" | "replace" | "apply_patch" | "multiedit" => "Edit",
        "read" | "read_file" | "read_many_files" => "Read",
        "webfetch" | "web_fetch" => "WebFetch",
        "websearch" | "google_web_search" | "web_search" => "WebSearch",
        "glob" => "Glob",
        "grep" | "search_file_content" => "Grep",
        _ => tool,
    }
}

/// The text a rule's pattern is matched against for a given tool call.
pub fn subject_for(tool: &str, input: &Value) -> String {
    let field = |k: &str| input.get(k).and_then(Value::as_str).map(str::to_string);
    if tool.ends_with("send_keys") && (tool.contains(TERM_SERVER) || tool.contains(LEGACY_TERM_SERVER)) {
        let keys = input
            .get("keys")
            .and_then(Value::as_array)
            .map(|k| k.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(" "));
        return format!(
            "{}{}",
            field("text").unwrap_or_default(),
            keys.map(|k| format!(" [{k}]")).unwrap_or_default()
        );
    }
    // Field names differ per agent: file_path, filePath, absolute_path, path.
    let path = || {
        field("file_path")
            .or_else(|| field("filePath"))
            .or_else(|| field("absolute_path"))
            .or_else(|| field("path"))
    };
    match rule_tool_name(tool) {
        // Codex's apply_patch carries the whole patch (with file paths) in `command`.
        "Bash" | "PowerShell" => field("command").or_else(|| field("cmd")),
        "Edit" if tool == "apply_patch" => field("command").or_else(|| field("input")),
        "Read" | "Write" | "Edit" | "MultiEdit" => path(),
        "NotebookEdit" => field("notebook_path"),
        "WebFetch" => field("url"),
        "WebSearch" => field("query"),
        "Glob" | "Grep" => field("pattern").map(|p| format!("{p} {}", field("path").unwrap_or_default())),
        _ => None,
    }
    .unwrap_or_else(|| input.to_string())
}

#[derive(Serialize, Clone, Debug)]
pub struct Decision {
    pub action: Action,
    pub rule: Option<String>,
    pub subject: String,
}

pub fn evaluate(cfg: &GuardConfig, tool: &str, input: &Value) -> Decision {
    let subject = subject_for(tool, input);
    if !cfg.enabled {
        return Decision {
            action: Action::Allow,
            rule: None,
            subject,
        };
    }
    for rule in cfg.rules.iter().filter(|r| r.enabled) {
        let tool_re = Regex::new(&format!("^(?:{})$", rule.tool));
        let pat_re = Regex::new(&rule.pattern);
        if let (Ok(t), Ok(p)) = (tool_re, pat_re) {
            if (t.is_match(tool) || t.is_match(rule_tool_name(tool))) && p.is_match(&subject) {
                return Decision {
                    action: rule.action,
                    rule: Some(rule.name.clone()),
                    subject,
                };
            }
        }
    }
    Decision {
        action: cfg.default_action,
        rule: None,
        subject,
    }
}

fn validate(cfg: &GuardConfig) -> Result<(), String> {
    for rule in &cfg.rules {
        Regex::new(&format!("^(?:{})$", rule.tool)).map_err(|e| {
            format!(
                "{} “{}”: {e}",
                tr("Invalid tool pattern in rule", "Pola tool tidak valid pada aturan"),
                rule.name
            )
        })?;
        Regex::new(&rule.pattern).map_err(|e| {
            format!(
                "{} “{}”: {e}",
                tr(
                    "Invalid match pattern in rule",
                    "Pola pencocokan tidak valid pada aturan"
                ),
                rule.name
            )
        })?;
    }
    Ok(())
}

fn log_decision(tool: &str, d: &Decision, outcome: &str) {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let line = json!({ "ts": ts, "tool": tool, "subject": d.subject, "rule": d.rule, "outcome": outcome });
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(log_path()) {
        let _ = writeln!(f, "{line}");
    }
}

// ---------------------------------------------------------------------------
// Hook mode: `yuxoterm --guard-hook`, invoked by Claude Code.
// ---------------------------------------------------------------------------

fn hook_output(decision: &str, reason: &str) {
    let out = json!({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": decision,
            "permissionDecisionReason": reason,
        }
    });
    println!("{out}");
}

/// Blocks the tool call in the calling agent's protocol. Claude Code and Codex
/// read PreToolUse JSON; Gemini CLI and the OpenCode plugin use exit code 2
/// with the reason on stderr (Codex and Claude also accept that).
fn hook_deny(agent: &str, reason: &str) -> i32 {
    match agent {
        "claude" | "codex" => {
            hook_output("deny", reason);
            0
        }
        _ => {
            eprintln!("{reason}");
            2
        }
    }
}

pub fn run_hook() -> i32 {
    let args: Vec<String> = std::env::args().collect();
    let agent = args
        .iter()
        .position(|a| a == "--agent")
        .and_then(|i| args.get(i + 1))
        .map(String::as_str)
        .unwrap_or("claude")
        .to_string();
    let mut raw = String::new();
    if std::io::stdin().read_to_string(&mut raw).is_err() {
        return 0;
    }
    let Ok(event) = serde_json::from_str::<Value>(&raw) else {
        return 0;
    };
    let tool = event.get("tool_name").and_then(Value::as_str).unwrap_or("");
    let input = event.get("tool_input").cloned().unwrap_or(Value::Null);
    let cfg = load();
    let d = evaluate(&cfg, tool, &input);
    let rule = d.rule.clone().unwrap_or_else(|| "default action".into());

    match d.action {
        Action::Allow => {
            log_decision(tool, &d, "allow");
            0
        }
        Action::Deny => {
            log_decision(tool, &d, "deny");
            hook_deny(&agent, &format!("Blocked by YuxoTerm guard (rule: {rule})."))
        }
        Action::Ask => match ask_app(&event, tool, &d, cfg.ask_timeout_secs) {
            Some(true) => {
                log_decision(tool, &d, "approved");
                if agent == "claude" {
                    hook_output("allow", &format!("Approved by the user in YuxoTerm (rule: {rule})."));
                }
                0
            }
            Some(false) => {
                log_decision(tool, &d, "rejected");
                hook_deny(&agent, &format!("Denied by the user in YuxoTerm guard (rule: {rule})."))
            }
            // Outside the app only Claude Code can prompt the user itself; for the
            // others "ask" would let the call through, so fail closed.
            None if agent == "claude" => {
                log_decision(tool, &d, "ask");
                hook_output("ask", &format!("YuxoTerm guard asks for confirmation (rule: {rule})."));
                0
            }
            None => {
                log_decision(tool, &d, "denied-no-app");
                hook_deny(
                    &agent,
                    &format!("Needs approval in YuxoTerm, which isn't reachable (rule: {rule})."),
                )
            }
        },
    }
}

#[cfg(unix)]
fn ask_app(event: &Value, tool: &str, d: &Decision, timeout: u64) -> Option<bool> {
    use std::os::unix::net::UnixStream;
    let sock = std::env::var(SOCK_ENV).ok()?;
    let mut stream = UnixStream::connect(sock).ok()?;
    stream.set_read_timeout(Some(Duration::from_secs(timeout + 5))).ok()?;
    let req = json!({
        "tool": tool,
        "subject": d.subject,
        "rule": d.rule,
        "cwd": event.get("cwd"),
        "session_id": event.get("session_id"),
        "input": event.get("tool_input"),
    });
    writeln!(stream, "{req}").ok()?;
    let mut line = String::new();
    BufReader::new(stream).read_line(&mut line).ok()?;
    serde_json::from_str::<Value>(&line).ok()?.get("allow")?.as_bool()
}

#[cfg(not(unix))]
fn ask_app(_: &Value, _: &str, _: &Decision, _: u64) -> Option<bool> {
    None
}

// ---------------------------------------------------------------------------
// App side: approval broker listening on a Unix socket.
// ---------------------------------------------------------------------------

#[derive(Default)]
pub struct AskBroker {
    pending: Mutex<HashMap<u64, mpsc::Sender<bool>>>,
    /// Terminal tool calls from the MCP server, answered by the UI.
    tool_pending: Mutex<HashMap<u64, mpsc::Sender<Value>>>,
    next: AtomicU64,
    pub sock_path: Mutex<Option<PathBuf>>,
}

#[cfg(unix)]
pub fn start_broker(app: AppHandle, broker: Arc<AskBroker>) {
    use std::os::unix::net::UnixListener;
    let dir = config_dir().join("run");
    let _ = fs::create_dir_all(&dir);
    remove_stale_sockets(&dir);
    let path = dir.join(format!("guard-{}.sock", std::process::id()));
    let _ = fs::remove_file(&path);
    let Ok(listener) = UnixListener::bind(&path) else {
        return;
    };
    *broker.sock_path.lock().unwrap() = Some(path);

    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let app = app.clone();
            let broker = broker.clone();
            std::thread::spawn(move || {
                let mut reader = BufReader::new(&stream);
                let mut line = String::new();
                if reader.read_line(&mut line).is_err() {
                    return;
                }
                let Ok(mut req) = serde_json::from_str::<Value>(&line) else {
                    return;
                };
                let id = broker.next.fetch_add(1, Ordering::SeqCst) + 1;
                if req.get("kind").and_then(Value::as_str) == Some("tool") {
                    handle_tool_call(&app, &broker, &stream, id, req);
                    return;
                }
                let (tx, rx) = mpsc::channel();
                broker.pending.lock().unwrap().insert(id, tx);
                req["id"] = json!(id);
                let _ = app.emit("guard-ask", req);

                // Poll so the dialog closes as soon as the hook goes away
                // (e.g. the user pressed Stop on the Claude run).
                let deadline = std::time::Instant::now() + Duration::from_secs(load().ask_timeout_secs);
                let _ = stream.set_nonblocking(true);
                let allow = loop {
                    match rx.recv_timeout(Duration::from_millis(400)) {
                        Ok(v) => break v,
                        Err(mpsc::RecvTimeoutError::Disconnected) => break false,
                        Err(mpsc::RecvTimeoutError::Timeout) => {
                            // The hook sends nothing after its request, so EOF means it exited.
                            let mut probe = [0u8; 1];
                            let gone = matches!((&stream).read(&mut probe), Ok(0));
                            if gone || std::time::Instant::now() >= deadline {
                                break false;
                            }
                        }
                    }
                };
                let _ = stream.set_nonblocking(false);
                broker.pending.lock().unwrap().remove(&id);
                let _ = app.emit("guard-ask-closed", id);
                let mut stream = &stream;
                let _ = writeln!(stream, "{}", json!({ "allow": allow }));
            });
        }
    });
}

/// Deletes sockets left behind by app instances that did not exit cleanly.
#[cfg(unix)]
fn remove_stale_sockets(dir: &std::path::Path) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for path in entries.flatten().map(|e| e.path()) {
        if path.extension().is_some_and(|e| e == "sock") && std::os::unix::net::UnixStream::connect(&path).is_err() {
            let _ = fs::remove_file(path);
        }
    }
}

/// Forwards one MCP terminal tool call to the UI (which owns the panes) and
/// writes the UI's answer back to the MCP server process.
#[cfg(unix)]
fn handle_tool_call(
    app: &AppHandle,
    broker: &AskBroker,
    stream: &std::os::unix::net::UnixStream,
    id: u64,
    mut req: Value,
) {
    let (tx, rx) = mpsc::channel();
    broker.tool_pending.lock().unwrap().insert(id, tx);
    req["id"] = json!(id);
    let wait_ms = req
        .pointer("/args/timeout_ms")
        .and_then(Value::as_u64)
        .unwrap_or(30_000)
        .min(600_000);
    let _ = app.emit("agent-tool", req);
    let reply = rx
        .recv_timeout(Duration::from_millis(wait_ms + 30_000))
        .unwrap_or_else(|_| json!({ "error": "YuxoTerm did not respond" }));
    broker.tool_pending.lock().unwrap().remove(&id);
    let mut stream = stream;
    let _ = writeln!(stream, "{reply}");
}

#[cfg(not(unix))]
pub fn start_broker(_: AppHandle, _: Arc<AskBroker>) {}

pub fn cleanup_broker(broker: &AskBroker) {
    if let Some(p) = broker.sock_path.lock().unwrap().take() {
        let _ = fs::remove_file(p);
    }
}

// ---------------------------------------------------------------------------
// Hook wiring for Claude Code.
// ---------------------------------------------------------------------------

pub fn hook_command() -> String {
    let exe = std::env::current_exe().unwrap_or_default().display().to_string();
    format!("'{}' {HOOK_FLAG}", exe.replace('\'', r"'\''"))
}

/// Settings JSON passed to app-launched sessions via `claude --settings`.
pub fn session_settings() -> String {
    json!({ "hooks": session_hooks() }).to_string()
}

pub fn session_hooks() -> Value {
    json!({
        "PreToolUse": [{
            "matcher": "*",
            "hooks": [{ "type": "command", "command": hook_command(), "timeout": 3600 }]
        }]
    })
}

fn claude_settings_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_default()
        .join(".claude")
        .join("settings.json")
}

fn is_our_hook(entry: &Value) -> bool {
    entry
        .get("hooks")
        .and_then(Value::as_array)
        .map(|hs| {
            hs.iter().any(|h| {
                h.get("command")
                    .and_then(Value::as_str)
                    .is_some_and(|c| c.contains(HOOK_FLAG))
            })
        })
        .unwrap_or(false)
}

pub fn global_installed() -> bool {
    let Ok(s) = fs::read_to_string(claude_settings_path()) else {
        return false;
    };
    let Ok(v) = serde_json::from_str::<Value>(&s) else {
        return false;
    };
    v.pointer("/hooks/PreToolUse")
        .and_then(Value::as_array)
        .is_some_and(|a| a.iter().any(is_our_hook))
}

// ---------------------------------------------------------------------------
// Tauri commands.
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn get_guard() -> GuardConfig {
    load()
}

#[tauri::command]
pub fn save_guard(guard: GuardConfig) -> Result<(), String> {
    validate(&guard)?;
    write_json(&guard_path(), &guard)
}

#[tauri::command]
pub fn reset_guard() -> Result<GuardConfig, String> {
    let cfg = GuardConfig::default();
    write_json(&guard_path(), &cfg)?;
    Ok(cfg)
}

#[tauri::command]
pub fn test_guard(guard: GuardConfig, tool: String, subject: String) -> Result<Decision, String> {
    validate(&guard)?;
    let key = match tool.as_str() {
        "Bash" | "PowerShell" => "command",
        "Read" | "Write" | "Edit" | "MultiEdit" => "file_path",
        "NotebookEdit" => "notebook_path",
        "WebFetch" => "url",
        "WebSearch" => "query",
        _ => "value",
    };
    Ok(evaluate(&guard, &tool, &json!({ key: subject })))
}

#[tauri::command]
pub fn agent_tool_result(broker: State<Arc<AskBroker>>, id: u64, result: Value) {
    if let Some(tx) = broker.tool_pending.lock().unwrap().remove(&id) {
        let _ = tx.send(result);
    }
}

#[tauri::command]
pub fn guard_respond(broker: State<Arc<AskBroker>>, id: u64, allow: bool) {
    if let Some(tx) = broker.pending.lock().unwrap().remove(&id) {
        let _ = tx.send(allow);
    }
}

#[derive(Serialize)]
pub struct GuardInfo {
    guard_path: String,
    log_path: String,
    claude_settings_path: String,
    global_installed: bool,
    hook_command: String,
}

#[tauri::command]
pub fn guard_info() -> GuardInfo {
    GuardInfo {
        guard_path: guard_path().display().to_string(),
        log_path: log_path().display().to_string(),
        claude_settings_path: claude_settings_path().display().to_string(),
        global_installed: global_installed(),
        hook_command: hook_command(),
    }
}

/// Executable path inside a hook command written by `hook_command`.
fn hook_exe(command: &str) -> Option<String> {
    let rest = command.strip_prefix('\'')?;
    Some(rest[..rest.find('\'')?].to_string())
}

/// Re-points a globally installed hook at this executable when the one it
/// names is gone (the app was moved or renamed, e.g. Agentic Terminal → YuxoTerm).
pub fn refresh_global() {
    let Ok(s) = fs::read_to_string(claude_settings_path()) else {
        return;
    };
    let Ok(v) = serde_json::from_str::<Value>(&s) else {
        return;
    };
    let broken = v
        .pointer("/hooks/PreToolUse")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|e| is_our_hook(e))
        .flat_map(|e| e.get("hooks").and_then(Value::as_array).cloned().unwrap_or_default())
        .filter_map(|h| h.get("command").and_then(Value::as_str).and_then(hook_exe))
        .any(|exe| !std::path::Path::new(&exe).exists());
    if broken {
        let _ = guard_install_global(true);
    }
}

/// Adds or removes the guard hook in `~/.claude/settings.json`, leaving every
/// other setting untouched.
#[tauri::command]
pub fn guard_install_global(enable: bool) -> Result<bool, String> {
    let path = claude_settings_path();
    let mut settings: Value = match fs::read_to_string(&path) {
        Ok(s) if !s.trim().is_empty() => serde_json::from_str(&s).map_err(|e| {
            format!(
                "{} {}: {e}",
                path.display(),
                tr("isn't valid JSON", "bukan JSON yang valid")
            )
        })?,
        _ => json!({}),
    };
    if !settings.is_object() {
        return Err(format!(
            "{} {}",
            path.display(),
            tr("must contain a JSON object", "harus berisi objek JSON")
        ));
    }
    let hooks = settings
        .as_object_mut()
        .unwrap()
        .entry("hooks")
        .or_insert_with(|| json!({}));
    let list = hooks
        .as_object_mut()
        .ok_or_else(|| {
            tr(
                "\"hooks\" in Claude settings must be an object",
                "\"hooks\" di pengaturan Claude harus berupa objek",
            )
        })?
        .entry("PreToolUse")
        .or_insert_with(|| json!([]))
        .as_array_mut()
        .ok_or_else(|| {
            tr(
                "\"hooks.PreToolUse\" in Claude settings must be a list",
                "\"hooks.PreToolUse\" di pengaturan Claude harus berupa daftar",
            )
        })?;
    list.retain(|e| !is_our_hook(e));
    if enable {
        list.push(json!({
            "matcher": "*",
            "hooks": [{ "type": "command", "command": hook_command(), "timeout": 3600 }]
        }));
    }
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let body = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    fs::write(&path, body + "\n").map_err(|e| e.to_string())?;
    Ok(global_installed())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decide(tool: &str, key: &str, v: &str) -> Action {
        evaluate(&GuardConfig::default(), tool, &json!({ key: v })).action
    }

    #[test]
    fn default_rules() {
        assert_eq!(decide("Bash", "command", "rm -rf /"), Action::Deny);
        assert_eq!(decide("Bash", "command", "rm -rf ~"), Action::Deny);
        assert_eq!(decide("Bash", "command", "rm -rf ./build"), Action::Ask);
        assert_eq!(decide("Bash", "command", "ls && sudo make install"), Action::Ask);
        assert_eq!(decide("Bash", "command", "git push origin main"), Action::Ask);
        assert_eq!(decide("Bash", "command", "curl -fsSL x.sh | bash"), Action::Ask);
        assert_eq!(decide("Bash", "command", "git status"), Action::Allow);
        assert_eq!(decide("Write", "file_path", "/Users/a/.ssh/config"), Action::Deny);
        assert_eq!(decide("Write", "file_path", "/Users/a/src/main.rs"), Action::Allow);
        let run = format!("mcp__{TERM_SERVER}__run_command");
        assert_eq!(decide(&run, "command", "sudo make install"), Action::Ask);
        assert_eq!(decide(&run, "command", "rm -rf /"), Action::Deny);
        assert_eq!(decide(&run, "command", "php -v"), Action::Allow);
        assert_eq!(
            decide(
                &format!("mcp__{TERM_SERVER}__send_keys"),
                "text",
                "git push origin main"
            ),
            Action::Ask
        );
        // Other agents' tool names map onto the same rules.
        assert_eq!(decide("run_shell_command", "command", "rm -rf /"), Action::Deny);
        assert_eq!(decide("bash", "command", "sudo make install"), Action::Ask);
        assert_eq!(decide("write", "filePath", "/Users/a/.ssh/config"), Action::Deny);
        assert_eq!(decide("write_file", "file_path", "/Users/a/.ssh/id_rsa"), Action::Deny);
        assert_eq!(
            decide(&format!("{TERM_SERVER}_run_command"), "command", "git push"),
            Action::Ask
        );
    }

    #[test]
    fn default_rules_compile() {
        validate(&GuardConfig::default()).unwrap();
    }
}
