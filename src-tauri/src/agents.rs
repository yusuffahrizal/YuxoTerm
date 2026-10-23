//! Runs coding agents headlessly and streams their JSON events to the sidebar.
//!
//! Each agent has its own CLI flags, session resume syntax and way of taking
//! extra configuration. This module maps the sidebar's request (prompt, model,
//! effort, thinking, access level) onto those flags, and wires in the two
//! things that make YuxoTerm agentic: the `yuxoterm` MCP server
//! (drives the user's panes) and the Command Guard hook, wherever the agent
//! offers a way to add them for a single run. The UI parses each agent's output
//! format (see `ui/agents.js`).

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::config::{self, config_dir, tr, AgentSettings, AppConfig};
use crate::guard::{self, AskBroker, LEGACY_TERM_SERVER, TERM_SERVER};
use crate::{history, mcp, shellenv};

const SYSTEM_PROMPT: &str = "You are running inside YuxoTerm, a desktop terminal app. \
The user talks to you from a sidebar next to their real terminal panes, and you can drive those panes \
with the yuxoterm tools (list_panes, run_command, send_keys, read_screen, open_pane). \
Use them whenever the user asks you to do something in the terminal: commands they should see, \
entering and working inside ssh / `docker exec -it` / database shells / REPLs, starting servers, \
tailing logs, or continuing in whatever the pane is already running. Never tell the user to run a \
command themselves when you can run it in their pane. Your own built-in shell tool runs in a separate \
hidden shell; keep it for quick non-interactive checks and file inspection. Before typing into a pane, \
read_screen if you are unsure what it is currently running (a shell prompt, a container shell, a REPL, \
or a busy process). When the user's message includes a <terminal> block, it is the recent visible \
output of their active pane. Tool calls pass through a centralized command guard; if a call is \
denied, explain what was blocked and suggest an alternative instead of retrying the same command.";

/// How much of an agent's activity Command Guard can check.
#[derive(Serialize, Clone, Copy)]
#[serde(rename_all = "snake_case")]
enum GuardCoverage {
    /// Every tool call, via a hook the agent runs before each tool.
    Full,
    /// Only the yuxoterm tools; the agent's own tools aren't hookable per run.
    TerminalTools,
}

struct Spec {
    id: &'static str,
    name: &'static str,
    bins: &'static [&'static str],
    /// Environment variable that receives the API key from Settings.
    key_env: &'static str,
    install: &'static str,
    guard: GuardCoverage,
    /// Where the terminal tools must be registered globally (agents with no
    /// per-run MCP option). `None` means they're added to every run.
    global_mcp: Option<&'static str>,
}

const SPECS: &[Spec] = &[
    Spec {
        id: "claude",
        name: "Claude Code",
        bins: &["claude"],
        key_env: "ANTHROPIC_API_KEY",
        install: "https://claude.com/claude-code",
        guard: GuardCoverage::Full,
        global_mcp: None,
    },
    Spec {
        id: "codex",
        name: "Codex",
        bins: &["codex"],
        key_env: "CODEX_API_KEY",
        install: "npm install -g @openai/codex",
        guard: GuardCoverage::Full,
        global_mcp: None,
    },
    Spec {
        id: "antigravity",
        name: "Antigravity",
        bins: &["agy"],
        key_env: "GEMINI_API_KEY",
        install: "https://antigravity.google/cli",
        guard: GuardCoverage::TerminalTools,
        global_mcp: Some(".gemini/config/mcp_config.json"),
    },
    Spec {
        id: "gemini",
        name: "Gemini CLI",
        bins: &["gemini"],
        key_env: "GEMINI_API_KEY",
        install: "npm install -g @google/gemini-cli",
        guard: GuardCoverage::Full,
        global_mcp: None,
    },
    Spec {
        id: "cursor",
        name: "Cursor Agent",
        bins: &["cursor-agent", "agent"],
        key_env: "CURSOR_API_KEY",
        install: "https://cursor.com/cli",
        guard: GuardCoverage::TerminalTools,
        global_mcp: Some(".cursor/mcp.json"),
    },
    Spec {
        id: "opencode",
        name: "OpenCode",
        bins: &["opencode"],
        key_env: "",
        install: "https://opencode.ai",
        guard: GuardCoverage::Full,
        global_mcp: None,
    },
];

fn spec(id: &str) -> Result<&'static Spec, String> {
    SPECS
        .iter()
        .find(|s| s.id == id)
        .ok_or_else(|| format!("{}: {id}", tr("Unknown agent", "Agent tidak dikenal")))
}

#[derive(Default)]
pub struct AgentState {
    runs: Mutex<HashMap<String, Arc<Mutex<Child>>>>,
}

#[derive(Deserialize)]
pub struct SendArgs {
    run_id: String,
    /// Tab whose panes the terminal tools act on by default.
    tab_id: String,
    agent: String,
    prompt: String,
    cwd: Option<String>,
    resume: Option<String>,
    model: Option<String>,
    effort: Option<String>,
    thinking: Option<String>,
}

#[derive(Serialize, Clone)]
struct EventLine {
    run_id: String,
    line: String,
}

#[derive(Serialize, Clone)]
struct Done {
    run_id: String,
    code: Option<i32>,
    stderr: String,
}

fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// TOML basic string; JSON string escapes are a valid subset.
fn toml_str(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_default()
}

fn resolve_bin(spec: &Spec, settings: &AgentSettings) -> Result<PathBuf, String> {
    if !settings.path.trim().is_empty() {
        return Ok(PathBuf::from(settings.path.trim()));
    }
    spec.bins.iter().find_map(|b| shellenv::which(b)).ok_or_else(|| {
        format!(
            "{} {} — {}: {}",
            spec.name,
            tr("wasn't found", "tidak ditemukan"),
            tr("install it with", "instal dengan"),
            spec.install
        )
    })
}

fn instructions(cfg: &AppConfig) -> String {
    let mut s = SYSTEM_PROMPT.to_string();
    if !cfg.append_system_prompt.trim().is_empty() {
        s.push_str("\n\n");
        s.push_str(cfg.append_system_prompt.trim());
    }
    s
}

fn hook_command(agent: &str) -> String {
    format!("{} --agent {agent}", guard::hook_command())
}

fn exe_path() -> String {
    std::env::current_exe().unwrap_or_default().display().to_string()
}

/// Everything the per-agent builders need besides the request itself.
struct RunCtx<'a> {
    cfg: &'a AppConfig,
    tab: &'a str,
    sock: Option<PathBuf>,
    cwd: PathBuf,
    model: String,
    effort: String,
    thinking: String,
    resume: Option<String>,
}

impl RunCtx<'_> {
    fn mcp_env(&self) -> Value {
        match &self.sock {
            Some(s) => json!({ guard::SOCK_ENV: s.display().to_string() }),
            None => json!({}),
        }
    }
    fn mcp_args(&self) -> Vec<String> {
        vec!["--mcp-server".into(), "--tab".into(), self.tab.into()]
    }
    fn bypass(&self) -> bool {
        matches!(
            self.cfg.permission_mode.as_str(),
            "bypassPermissions" | "dontAsk" | "auto" | ""
        )
    }
}

/// How the prompt reaches the agent.
enum PromptVia {
    Stdin,
    /// Already placed in the argument list.
    Args,
}

fn build_claude(cmd: &mut Command, ctx: &RunCtx, sock: Option<&Path>) -> PromptVia {
    cmd.args([
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
    ]);
    if !ctx.cfg.permission_mode.is_empty() {
        cmd.args(["--permission-mode", &ctx.cfg.permission_mode]);
    }
    if !ctx.model.is_empty() {
        cmd.args(["--model", &ctx.model]);
    }
    if ["low", "medium", "high", "xhigh", "max"].contains(&ctx.effort.as_str()) {
        cmd.args(["--effort", &ctx.effort]);
    }
    if let Some(id) = &ctx.resume {
        cmd.args(["--resume", id]);
    }
    cmd.args(["--append-system-prompt", &instructions(ctx.cfg)]);
    // A globally installed hook already covers this session; adding it twice
    // would ask the user twice for the same call.
    if !guard::global_installed() {
        cmd.args(["--settings", &json!({ "hooks": guard::session_hooks() }).to_string()]);
    }
    // `--thinking` / `--thinking-display` are hidden Claude Code flags; "summarized"
    // makes thinking blocks appear in the stream so the sidebar can show them.
    match ctx.thinking.as_str() {
        "on" => {
            cmd.args(["--thinking", "enabled"]);
            if ctx.cfg.thinking_budget > 0 {
                cmd.env("MAX_THINKING_TOKENS", ctx.cfg.thinking_budget.to_string());
            }
        }
        "off" => {
            cmd.args(["--thinking", "disabled"]);
        }
        _ => {}
    }
    cmd.args(["--thinking-display", "summarized"]);
    cmd.args(["--mcp-config", &mcp::session_config(ctx.tab, sock)]);
    // Pre-approve the terminal tools so non-bypass permission modes don't
    // silently deny them in headless mode; the guard hook still checks each call.
    cmd.args(["--allowedTools", &format!("mcp__{TERM_SERVER}")]);
    PromptVia::Stdin
}

fn build_codex(cmd: &mut Command, ctx: &RunCtx) -> PromptVia {
    cmd.args(["exec", "--json", "--skip-git-repo-check"]);
    match ctx.cfg.permission_mode.as_str() {
        "acceptEdits" | "dontAsk" => {
            cmd.args(["--sandbox", "workspace-write"]);
        }
        "plan" => {
            cmd.args(["--sandbox", "read-only"]);
        }
        "auto" => {
            cmd.arg("--approve-for-me");
        }
        _ => {
            cmd.arg("--dangerously-bypass-approvals-and-sandbox");
        }
    }
    if !ctx.model.is_empty() {
        cmd.args(["-m", &ctx.model]);
    }
    // Codex tops out at xhigh.
    let effort = if ctx.effort == "max" {
        "xhigh"
    } else {
        ctx.effort.as_str()
    };
    if ["low", "medium", "high", "xhigh"].contains(&effort) {
        cmd.args(["-c", &format!("model_reasoning_effort={}", toml_str(effort))]);
    }
    match ctx.thinking.as_str() {
        "on" => {
            cmd.args(["-c", "model_reasoning_summary=\"detailed\""]);
        }
        "off" => {
            cmd.args(["-c", "model_reasoning_summary=\"none\""]);
        }
        _ => {}
    }
    cmd.args([
        "-c",
        &format!("developer_instructions={}", toml_str(&instructions(ctx.cfg))),
    ]);

    let args: Vec<String> = ctx.mcp_args().iter().map(|a| toml_str(a)).collect();
    let env: Vec<String> = ctx
        .mcp_env()
        .as_object()
        .map(|m| {
            m.iter()
                .map(|(k, v)| format!("{k} = {}", toml_str(v.as_str().unwrap_or(""))))
                .collect()
        })
        .unwrap_or_default();
    cmd.args([
        "-c",
        &format!(
            "mcp_servers.{TERM_SERVER}={{ command = {}, args = [{}], env = {{ {} }}, startup_timeout_sec = 30, tool_timeout_sec = 900 }}",
            toml_str(&exe_path()),
            args.join(", "),
            env.join(", ")
        ),
    ]);
    // Codex hooks speak the same PreToolUse protocol as Claude Code. They must be
    // trusted before they run; this run vouches for its own hook only.
    cmd.args([
        "-c",
        &format!(
            "hooks.PreToolUse=[{{ matcher = \"*\", hooks = [{{ type = \"command\", command = {}, timeout = 3600 }}] }}]",
            toml_str(&hook_command("codex"))
        ),
        "--dangerously-bypass-hook-trust",
    ]);
    if let Some(id) = &ctx.resume {
        cmd.args(["resume", id]);
    }
    cmd.arg("-");
    PromptVia::Stdin
}

/// Removes // and /* */ comments outside strings (Gemini CLI settings are JSONC).
fn strip_json_comments(src: &str) -> String {
    let (mut out, mut chars) = (String::with_capacity(src.len()), src.chars().peekable());
    let (mut in_str, mut escaped) = (false, false);
    while let Some(c) = chars.next() {
        if in_str {
            out.push(c);
            if escaped {
                escaped = false
            } else if c == '\\' {
                escaped = true
            } else if c == '"' {
                in_str = false
            }
            continue;
        }
        match (c, chars.peek()) {
            ('"', _) => {
                in_str = true;
                out.push(c);
            }
            ('/', Some('/')) => {
                while let Some(&n) = chars.peek() {
                    if n == '\n' {
                        break;
                    }
                    chars.next();
                }
            }
            ('/', Some('*')) => {
                chars.next();
                let mut prev = ' ';
                for n in chars.by_ref() {
                    if prev == '*' && n == '/' {
                        break;
                    }
                    prev = n;
                }
            }
            _ => out.push(c),
        }
    }
    out
}

/// Gemini CLI only reads extra settings files owned by root, so the run gets
/// its own home instead (`GEMINI_CLI_HOME`): `.gemini` there links to every
/// entry of the user's real `~/.gemini` (sign-in, sessions, extensions) except
/// `settings.json`, which is the user's settings plus the terminal tools and
/// guard hook. The real `~/.gemini` is never modified.
fn gemini_home(tab: &str, server: Value, hook: Value) -> Result<PathBuf, String> {
    let home = config_dir().join("run").join(format!("gemini-home-{tab}"));
    let dot = home.join(".gemini");
    std::fs::create_dir_all(&dot).map_err(|e| e.to_string())?;
    let real = dirs::home_dir().unwrap_or_default().join(".gemini");
    // Drop links whose target disappeared, then link anything new.
    if let Ok(entries) = std::fs::read_dir(&dot) {
        for e in entries.flatten() {
            let p = e.path();
            if p.symlink_metadata().is_ok_and(|m| m.file_type().is_symlink()) && !p.exists() {
                let _ = std::fs::remove_file(&p);
            }
        }
    }
    if let Ok(entries) = std::fs::read_dir(&real) {
        for e in entries.flatten() {
            let link = dot.join(e.file_name());
            if e.file_name() == "settings.json" || link.symlink_metadata().is_ok() {
                continue;
            }
            #[cfg(unix)]
            std::os::unix::fs::symlink(e.path(), &link).map_err(|e| e.to_string())?;
        }
    }
    let mut settings: Value = std::fs::read_to_string(real.join("settings.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&strip_json_comments(&s)).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}));
    let root = settings.as_object_mut().unwrap();
    let servers = root.entry("mcpServers").or_insert_with(|| json!({}));
    if let Some(m) = servers.as_object_mut() {
        m.insert(TERM_SERVER.into(), server);
    }
    let hooks = root.entry("hooks").or_insert_with(|| json!({}));
    if let Some(h) = hooks.as_object_mut() {
        let list = h.entry("BeforeTool").or_insert_with(|| json!([]));
        if let Some(arr) = list.as_array_mut() {
            arr.retain(|e| !e.to_string().contains("--guard-hook"));
            arr.push(hook);
        }
    }
    config::write_json(&dot.join("settings.json"), &settings)?;
    Ok(home)
}

fn build_gemini(cmd: &mut Command, ctx: &RunCtx) -> Result<PromptVia, String> {
    cmd.args(["--output-format", "stream-json", "--skip-trust"]);
    let mode = match ctx.cfg.permission_mode.as_str() {
        "acceptEdits" => "auto_edit",
        "plan" => "plan",
        _ => "yolo",
    };
    cmd.args(["--approval-mode", mode]);
    if !ctx.model.is_empty() {
        cmd.args(["--model", &ctx.model]);
    }
    if let Some(id) = &ctx.resume {
        cmd.args(["--resume", id]);
    }
    let server = json!({
        "command": exe_path(),
        "args": ctx.mcp_args(),
        "env": ctx.mcp_env(),
        "timeout": 900_000,
        "trust": true
    });
    let hook = json!({
        "matcher": ".*",
        "hooks": [{ "type": "command", "command": hook_command("gemini"), "timeout": 3_600_000 }]
    });
    cmd.env("GEMINI_CLI_HOME", gemini_home(ctx.tab, server, hook)?);
    // The prompt arrives on stdin; a blank -p forces headless mode.
    cmd.args(["--prompt", " "]);
    Ok(PromptVia::Stdin)
}

fn build_antigravity(cmd: &mut Command, ctx: &RunCtx, prompt: &str) -> PromptVia {
    cmd.args(["--output-format", "stream-json"]);
    match ctx.cfg.permission_mode.as_str() {
        "acceptEdits" => {
            cmd.args(["--mode", "accept-edits"]);
        }
        "plan" => {
            cmd.args(["--mode", "plan"]);
        }
        "auto" => {
            cmd.args(["--mode", "auto"]);
        }
        _ => {
            cmd.arg("--dangerously-skip-permissions");
        }
    }
    if !ctx.model.is_empty() {
        cmd.args(["--model", &ctx.model]);
    }
    if !ctx.effort.is_empty() {
        let effort = if matches!(ctx.effort.as_str(), "xhigh" | "max") {
            "high"
        } else {
            ctx.effort.as_str()
        };
        cmd.args(["--effort", effort]);
    }
    if let Some(id) = &ctx.resume {
        cmd.args(["--conversation", id]);
    }
    cmd.args(["-p", prompt]);
    PromptVia::Args
}

fn build_cursor(cmd: &mut Command, ctx: &RunCtx, prompt: &str) -> PromptVia {
    cmd.args(["-p", "--output-format", "stream-json", "--trust"]);
    if ctx.bypass() {
        cmd.arg("--force");
    }
    if !ctx.model.is_empty() {
        cmd.args(["--model", &ctx.model]);
    }
    if let Some(id) = &ctx.resume {
        cmd.args(["--resume", id]);
    }
    cmd.arg(prompt);
    PromptVia::Args
}

/// Plugin that runs the guard hook before every OpenCode tool call; throwing
/// from `tool.execute.before` blocks the call.
fn opencode_plugin() -> Result<PathBuf, String> {
    let path = config_dir().join("opencode-guard.js");
    let body = format!(
        r#"// Generated by YuxoTerm: checks every tool call with Command Guard.
import {{ spawnSync }} from "node:child_process";

export const YuxoTermGuard = async ({{ directory }}) => ({{
  "tool.execute.before": async (input, output) => {{
    const payload = JSON.stringify({{ tool_name: input.tool, tool_input: output.args ?? {{}}, session_id: input.sessionID, cwd: directory }});
    const r = spawnSync({exe}, ["--guard-hook", "--agent", "opencode"], {{ input: payload, env: process.env, encoding: "utf8" }});
    if (r.status === 2) throw new Error((r.stderr || "").trim() || "Blocked by YuxoTerm guard");
  }},
}});
"#,
        exe = serde_json::to_string(&exe_path()).unwrap_or_default()
    );
    if std::fs::read_to_string(&path).ok().as_deref() != Some(body.as_str()) {
        std::fs::create_dir_all(config_dir()).map_err(|e| e.to_string())?;
        std::fs::write(&path, body).map_err(|e| e.to_string())?;
    }
    Ok(path)
}

fn build_opencode(cmd: &mut Command, ctx: &RunCtx, prompt: &str) -> Result<PromptVia, String> {
    cmd.args(["run", "--format", "json", "--dir"]).arg(&ctx.cwd);
    if ctx.bypass() {
        cmd.arg("--auto");
    }
    if !ctx.model.is_empty() {
        cmd.args(["--model", &ctx.model]);
    }
    if !ctx.effort.is_empty() {
        cmd.args(["--variant", &ctx.effort]);
    }
    if ctx.thinking != "off" {
        cmd.arg("--thinking");
    }
    if let Some(id) = &ctx.resume {
        cmd.args(["--session", id]);
    }
    let plugin = opencode_plugin()?;
    let mut command = vec![exe_path()];
    command.extend(ctx.mcp_args());
    let config = json!({
        "mcp": {
            TERM_SERVER: { "type": "local", "command": command, "environment": ctx.mcp_env(), "enabled": true, "timeout": 900_000 }
        },
        "plugin": [format!("file://{}", plugin.display())]
    });
    cmd.env("OPENCODE_CONFIG_CONTENT", config.to_string());
    // `--` keeps a prompt that starts with "-" from being read as a flag.
    cmd.arg("--").arg(prompt);
    Ok(PromptVia::Args)
}

/// Custom agent: the user's command line, run by the login shell, with the
/// prompt in `$YUXOTERM_PROMPT` (and substituted for `{prompt}`).
fn build_custom(settings: &AgentSettings, prompt: &str) -> Result<Command, String> {
    let template = settings.command.trim();
    if template.is_empty() {
        return Err(tr(
            "Set the command for your custom agent in Settings → Agents.",
            "Atur perintah untuk agent kustom Anda di Pengaturan → Agent.",
        ));
    }
    let line = if template.contains("{prompt}") {
        template.replace("{prompt}", "\"$YUXOTERM_PROMPT\"")
    } else {
        format!("{template} \"$YUXOTERM_PROMPT\"")
    };
    let mut cmd = Command::new(shellenv::user_shell(""));
    cmd.args(["-lc", &line]).env("YUXOTERM_PROMPT", prompt);
    Ok(cmd)
}

/// New sessions of agents without a system-prompt option get the app's
/// instructions as a preamble to the first message.
fn with_preamble(cfg: &AppConfig, prompt: &str) -> String {
    format!(
        "<yuxoterm-context>\n{}\n</yuxoterm-context>\n\n{prompt}",
        instructions(cfg)
    )
}

#[tauri::command]
pub fn agent_send(
    app: AppHandle,
    state: State<AgentState>,
    broker: State<Arc<AskBroker>>,
    args: SendArgs,
) -> Result<(), String> {
    let cfg = config::load();
    let settings = cfg.agent(&args.agent);
    let home = dirs::home_dir().unwrap_or_default();
    let cwd = args
        .cwd
        .as_deref()
        .map(PathBuf::from)
        .filter(|p| p.is_dir())
        .unwrap_or(home);
    let sock = broker.sock_path.lock().unwrap().clone();
    let resume = args.resume.clone().filter(|s| !s.is_empty());
    let pick = |v: Option<String>, d: &str| v.unwrap_or_else(|| d.to_string()).trim().to_string();
    let ctx = RunCtx {
        cfg: &cfg,
        model: pick(args.model.clone(), &settings.model),
        effort: pick(args.effort.clone(), &settings.effort),
        thinking: pick(args.thinking.clone(), &settings.thinking),
        tab: &args.tab_id,
        sock: sock.clone(),
        cwd: cwd.clone(),
        resume: resume.clone(),
    };

    let needs_preamble = resume.is_none() && !matches!(args.agent.as_str(), "claude" | "codex");
    let prompt = if needs_preamble {
        with_preamble(&cfg, &args.prompt)
    } else {
        args.prompt.clone()
    };

    let (mut cmd, via, label) = if args.agent == "custom" {
        (
            build_custom(&settings, &prompt)?,
            PromptVia::Args,
            tr("Custom agent", "Agent kustom"),
        )
    } else {
        let spec = spec(&args.agent)?;
        let bin = resolve_bin(spec, &settings)?;
        let mut cmd = Command::new(&bin);
        let via = match spec.id {
            "claude" => build_claude(&mut cmd, &ctx, sock.as_deref()),
            "codex" => build_codex(&mut cmd, &ctx),
            "gemini" => build_gemini(&mut cmd, &ctx)?,
            "antigravity" => build_antigravity(&mut cmd, &ctx, &prompt),
            "cursor" => build_cursor(&mut cmd, &ctx, &prompt),
            "opencode" => build_opencode(&mut cmd, &ctx, &prompt)?,
            _ => unreachable!(),
        };
        if !spec.key_env.is_empty() && !settings.api_key.trim().is_empty() {
            cmd.env(spec.key_env, settings.api_key.trim());
            if spec.id == "codex" {
                cmd.env("OPENAI_API_KEY", settings.api_key.trim());
            }
        }
        (cmd, via, bin.display().to_string())
    };
    if args.agent != "custom" {
        cmd.args(settings.extra_args.split_whitespace());
    }

    cmd.current_dir(&cwd);
    cmd.env("PATH", shellenv::login_path());
    if let Some(sock) = &sock {
        cmd.env(guard::SOCK_ENV, sock);
    }
    cmd.stdin(match via {
        PromptVia::Stdin => Stdio::piped(),
        PromptVia::Args => Stdio::null(),
    })
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("{} {label}: {e}", tr("Couldn't start", "Gagal menjalankan")))?;
    // Long prompts with terminal context go through stdin where the agent allows it.
    if let (PromptVia::Stdin, Some(mut stdin)) = (via, child.stdin.take()) {
        std::thread::spawn(move || {
            let _ = stdin.write_all(prompt.as_bytes());
        });
    }
    let stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    let child = Arc::new(Mutex::new(child));
    let run_id = args.run_id;
    state.runs.lock().unwrap().insert(run_id.clone(), child.clone());

    let err_buf = Arc::new(Mutex::new(String::new()));
    let err_sink = err_buf.clone();
    std::thread::spawn(move || {
        let mut s = String::new();
        let _ = stderr.read_to_string(&mut s);
        // Keep the tail: errors are usually printed last.
        let skip = s.chars().count().saturating_sub(8000);
        *err_sink.lock().unwrap() = s.chars().skip(skip).collect();
    });

    let is_claude = args.agent == "claude";
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if line.trim().is_empty() {
                continue;
            }
            if is_claude && line.contains("\"subtype\":\"init\"") {
                history::remember_app_session(&line);
            }
            let _ = app.emit(
                "agent-event",
                EventLine {
                    run_id: run_id.clone(),
                    line,
                },
            );
        }
        let code = child.lock().unwrap().wait().ok().and_then(|s| s.code());
        // Give the stderr reader a moment to finish after the process exits.
        std::thread::sleep(Duration::from_millis(50));
        let stderr = err_buf.lock().unwrap().clone();
        app.state::<AgentState>().runs.lock().unwrap().remove(&run_id);
        let _ = app.emit("agent-done", Done { run_id, code, stderr });
    });
    Ok(())
}

#[tauri::command]
pub fn agent_cancel(state: State<AgentState>, run_id: String) {
    if let Some(child) = state.runs.lock().unwrap().get(&run_id) {
        let _ = child.lock().unwrap().kill();
    }
}

#[derive(Serialize)]
pub struct AgentStatus {
    id: &'static str,
    name: &'static str,
    installed: bool,
    path: Option<String>,
    version: Option<String>,
    error: Option<String>,
    install: &'static str,
    guard: GuardCoverage,
    /// Only for agents whose terminal tools are registered globally.
    tools_installed: Option<bool>,
}

fn version_of(bin: &Path) -> Result<String, String> {
    let mut child = Command::new(bin)
        .arg("--version")
        .env("PATH", shellenv::login_path())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    let deadline = std::time::Instant::now() + Duration::from_secs(8);
    while child.try_wait().map_err(|e| e.to_string())?.is_none() {
        if std::time::Instant::now() > deadline {
            let _ = child.kill();
            return Err(tr("Timed out", "Waktu habis"));
        }
        std::thread::sleep(Duration::from_millis(30));
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(if out.stdout.is_empty() {
        &out.stderr
    } else {
        &out.stdout
    })
    .to_string();
    let first = text
        .lines()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("")
        .trim()
        .to_string();
    if out.status.success() {
        Ok(first)
    } else {
        Err(first)
    }
}

/// Models Claude Code offers this account, read from its control protocol so new releases
/// show up without a code change. Each entry carries `value`, `resolvedModel`, `displayName`,
/// `description` and `supportedEffortLevels`.
#[tauri::command]
pub async fn claude_models() -> Result<Vec<Value>, String> {
    tauri::async_runtime::spawn_blocking(fetch_claude_models)
        .await
        .map_err(|e| e.to_string())?
}

fn fetch_claude_models() -> Result<Vec<Value>, String> {
    let cfg = config::load();
    let spec = spec("claude")?;
    let settings = cfg.agent(spec.id);
    let bin = resolve_bin(spec, &settings)?;
    let mut cmd = Command::new(&bin);
    cmd.args([
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
    ])
    .env("PATH", shellenv::login_path())
    .current_dir(dirs::home_dir().unwrap_or_default())
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .stderr(Stdio::null());
    if !spec.key_env.is_empty() && !settings.api_key.trim().is_empty() {
        cmd.env(spec.key_env, settings.api_key.trim());
    }
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let mut stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let init =
        json!({ "type": "control_request", "request_id": "yuxoterm-init", "request": { "subtype": "initialize" } });
    writeln!(stdin, "{init}").map_err(|e| e.to_string())?;

    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if !line.contains("control_response") {
                continue;
            }
            let models = serde_json::from_str::<Value>(&line).ok().and_then(|v| {
                v.pointer("/response/response/models")
                    .and_then(Value::as_array)
                    .cloned()
            });
            if let Some(models) = models {
                let _ = tx.send(models);
                break;
            }
        }
    });
    let models = rx.recv_timeout(Duration::from_secs(20));
    // Keep stdin open until we have the answer, then stop the process.
    drop(stdin);
    let _ = child.kill();
    let _ = child.wait();
    models.map_err(|_| {
        tr(
            "Couldn't read the model list from Claude Code.",
            "Tidak dapat membaca daftar model dari Claude Code.",
        )
    })
}

/// Which agents are installed, with versions; checked in parallel off the UI thread.
#[tauri::command]
pub async fn agents_status() -> Vec<AgentStatus> {
    let cfg = config::load();
    let handles: Vec<_> = SPECS
        .iter()
        .map(|spec| {
            let settings = cfg.agent(spec.id);
            tauri::async_runtime::spawn_blocking(move || {
                let tools_installed = spec.global_mcp.map(global_tools_installed);
                let base = |installed, path, version, error| AgentStatus {
                    id: spec.id,
                    name: spec.name,
                    installed,
                    path,
                    version,
                    error,
                    install: spec.install,
                    guard: spec.guard,
                    tools_installed,
                };
                match resolve_bin(spec, &settings) {
                    Err(e) => base(false, None, None, Some(e)),
                    Ok(bin) => {
                        let path = Some(bin.display().to_string());
                        match version_of(&bin) {
                            Ok(v) => base(true, path, Some(v), None),
                            Err(e) => base(false, path, None, Some(e)),
                        }
                    }
                }
            })
        })
        .collect();
    let mut out = Vec::new();
    for h in handles {
        if let Ok(s) = h.await {
            out.push(s);
        }
    }
    out
}

/// Command line that starts the agent interactively in a terminal pane (for sign-in).
#[tauri::command]
pub fn agent_interactive_command(agent: String) -> Result<String, String> {
    let cfg = config::load();
    let spec = spec(&agent)?;
    let bin = resolve_bin(spec, &cfg.agent(&agent))?;
    let quoted = shell_quote(&bin.display().to_string());
    if spec.id == "claude" && !guard::global_installed() {
        return Ok(format!(
            "{quoted} --settings {}",
            shell_quote(&guard::session_settings())
        ));
    }
    Ok(quoted)
}

// ---------------------------------------------------------------------------
// Terminal tools for agents that only read MCP servers from a global file.
// ---------------------------------------------------------------------------

fn global_mcp_path(rel: &str) -> PathBuf {
    dirs::home_dir().unwrap_or_default().join(rel)
}

fn global_tools_installed(rel: &str) -> bool {
    std::fs::read_to_string(global_mcp_path(rel))
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .is_some_and(|v| v.pointer(&format!("/mcpServers/{TERM_SERVER}")).is_some())
}

/// Re-registers the terminal tools in agents' global MCP files when the entry
/// uses the pre-rename server name or points at an executable that's gone.
pub fn refresh_global_tools() {
    for spec in SPECS {
        let Some(rel) = spec.global_mcp else { continue };
        let Some(servers) = std::fs::read_to_string(global_mcp_path(rel))
            .ok()
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .and_then(|v| v.get("mcpServers").cloned())
        else {
            continue;
        };
        let legacy = servers.get(LEGACY_TERM_SERVER).is_some();
        let broken = servers
            .pointer(&format!("/{TERM_SERVER}/command"))
            .and_then(Value::as_str)
            .is_some_and(|c| !Path::new(c).exists());
        if legacy || broken {
            let _ = agent_tools_install(spec.id.to_string(), true);
        }
    }
}

/// Adds or removes the yuxoterm server in the agent's global MCP file,
/// leaving the user's other servers untouched. Without a tab id, tool calls go
/// to whichever tab is active in the running app.
#[tauri::command]
pub fn agent_tools_install(agent: String, enable: bool) -> Result<bool, String> {
    let spec = spec(&agent)?;
    let rel = spec
        .global_mcp
        .ok_or_else(|| tr("Not needed for this agent.", "Tidak diperlukan untuk agent ini."))?;
    let path = global_mcp_path(rel);
    let mut root: Value = match std::fs::read_to_string(&path) {
        Ok(s) if !s.trim().is_empty() => serde_json::from_str(&s).map_err(|e| {
            format!(
                "{} {}: {e}",
                path.display(),
                tr("isn't valid JSON", "bukan JSON yang valid")
            )
        })?,
        _ => json!({}),
    };
    let servers = root
        .as_object_mut()
        .ok_or_else(|| {
            format!(
                "{} {}",
                path.display(),
                tr("must contain a JSON object", "harus berisi objek JSON")
            )
        })?
        .entry("mcpServers")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or_else(|| tr("\"mcpServers\" must be an object", "\"mcpServers\" harus berupa objek"))?;
    servers.remove(LEGACY_TERM_SERVER);
    if enable {
        servers.insert(
            TERM_SERVER.into(),
            json!({ "command": exe_path(), "args": ["--mcp-server"] }),
        );
    } else {
        servers.remove(TERM_SERVER);
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let body = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    std::fs::write(&path, body + "\n").map_err(|e| e.to_string())?;
    Ok(global_tools_installed(rel))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_jsonc_comments() {
        let src = "{\n // note\n \"a\": \"x // not a comment\", /* block */ \"b\": 1\n}";
        let v: Value = serde_json::from_str(&strip_json_comments(src)).unwrap();
        assert_eq!(v["a"], "x // not a comment");
        assert_eq!(v["b"], 1);
    }

    /// Builds an overlay home against whatever $HOME points to; run with a fake
    /// HOME and inspect the result (see YUXOTERM_TEST_GEMINI_HOME).
    #[test]
    fn gemini_overlay_home() {
        if std::env::var("YUXOTERM_TEST_GEMINI_HOME").is_err() {
            return;
        }
        let home = gemini_home(
            "t9",
            json!({ "command": "/bin/echo", "args": ["--mcp-server"] }),
            json!({ "matcher": ".*", "hooks": [{ "type": "command", "command": "x --guard-hook" }] }),
        )
        .unwrap();
        println!("OVERLAY={}", home.display());
    }
}
