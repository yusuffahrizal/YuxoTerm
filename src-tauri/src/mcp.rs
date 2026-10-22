//! `yuxoterm --mcp-server --tab <id>`: a stdio MCP server that Claude Code
//! launches for sidebar sessions. It exposes tools that drive the user's real
//! terminal panes, forwarding each call over the app's Unix socket to the UI.

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};

use crate::guard::SOCK_ENV;

fn tools() -> Value {
    let pane = json!({ "type": "string", "description": "Pane id from list_panes. Default: the active pane of the user's current tab." });
    json!([
        {
            "name": "list_panes",
            "description": "List the terminal panes open in YuxoTerm (id, tab, cwd, title, which one is active). Use this to pick a pane.",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "run_command",
            "description": "Type a command into the user's real terminal pane, press Enter, wait until output stops, and return the new output. \
    Works wherever that pane currently is: a local shell, or inside ssh / `docker exec -it` / a REPL the pane is running. \
    Use this (not Bash) for anything the user should see, interactive sessions, containers, and long-running processes. \
    If the command is still running when the wait ends, the result says so; follow up with read_screen or send_keys.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "command": { "type": "string", "description": "Command line to type (Enter is pressed for you)." },
                    "pane_id": pane,
                    "timeout_ms": { "type": "integer", "description": "Max wait for output to settle (default 30000, max 600000)." },
                    "idle_ms": { "type": "integer", "description": "Output is considered finished after this much silence (default 1500)." }
                },
                "required": ["command"]
            }
        },
        {
            "name": "send_keys",
            "description": "Send raw input to a pane without pressing Enter automatically: answer prompts, type into a REPL, or press keys like C-c, Enter, Tab, Up, Esc. Returns the screen afterwards.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "text": { "type": "string", "description": "Literal text to type." },
                    "keys": { "type": "array", "items": { "type": "string" }, "description": "Named keys sent after text: Enter, Tab, Esc, Up, Down, Left, Right, Backspace, Space, C-a … C-z." },
                    "pane_id": pane,
                    "wait_ms": { "type": "integer", "description": "How long to wait for output before reading the screen (default 800)." }
                }
            }
        },
        {
            "name": "read_screen",
            "description": "Read the most recent lines of a pane (visible screen plus scrollback), as plain text.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "pane_id": pane,
                    "lines": { "type": "integer", "description": "Number of lines from the bottom (default 60, max 2000)." }
                }
            }
        },
        {
            "name": "open_pane",
            "description": "Open a new terminal pane (split right, split down, or new tab), optionally running a command in it. Use it to keep a server or log tail running while you work in another pane.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "direction": { "type": "string", "enum": ["right", "down", "tab"], "description": "Default: right." },
                    "cwd": { "type": "string" },
                    "command": { "type": "string", "description": "Command to start in the new pane." }
                }
            }
        }
    ])
}

/// Sends one tool call to the running app and returns its JSON answer.
#[cfg(unix)]
fn call_app(tab: &str, name: &str, args: &Value) -> Result<Value, String> {
    use std::os::unix::net::UnixStream;
    let mut stream = match std::env::var(SOCK_ENV) {
        Ok(sock) => UnixStream::connect(sock).map_err(|e| format!("Can't connect to YuxoTerm: {e}"))?,
        // Registered globally (no per-run env): use the most recent running app.
        Err(_) => discover_app().ok_or_else(|| "YuxoTerm is not running".to_string())?,
    };
    let req = json!({ "kind": "tool", "tab": tab, "name": name, "args": args });
    writeln!(stream, "{req}").map_err(|e| e.to_string())?;
    let mut line = String::new();
    BufReader::new(stream).read_line(&mut line).map_err(|e| e.to_string())?;
    let reply: Value = serde_json::from_str(&line).map_err(|_| "Invalid reply from YuxoTerm".to_string())?;
    match reply.get("error").and_then(Value::as_str) {
        Some(err) => Err(err.to_string()),
        None => Ok(reply.get("result").cloned().unwrap_or(Value::Null)),
    }
}

#[cfg(unix)]
fn discover_app() -> Option<std::os::unix::net::UnixStream> {
    let dir = crate::config::config_dir().join("run");
    let mut socks: Vec<_> = std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "sock"))
        .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
        .collect();
    socks.sort_by_key(|s| std::cmp::Reverse(s.0));
    socks
        .into_iter()
        .find_map(|(_, p)| std::os::unix::net::UnixStream::connect(p).ok())
}

#[cfg(not(unix))]
fn call_app(_: &str, _: &str, _: &Value) -> Result<Value, String> {
    Err("Only supported on macOS and Linux".into())
}

fn handle(tab: &str, msg: &Value) -> Option<Value> {
    let id = msg.get("id")?.clone();
    let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
    let result = match method {
        "initialize" => {
            let version = msg
                .pointer("/params/protocolVersion")
                .and_then(Value::as_str)
                .unwrap_or("2025-06-18");
            json!({
                "protocolVersion": version,
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "yuxoterm", "version": env!("CARGO_PKG_VERSION") }
            })
        }
        "ping" => json!({}),
        "tools/list" => json!({ "tools": tools() }),
        "tools/call" => {
            let name = msg.pointer("/params/name").and_then(Value::as_str).unwrap_or("");
            let args = msg.pointer("/params/arguments").cloned().unwrap_or(json!({}));
            let (text, is_error) = match call_app(tab, name, &args) {
                Ok(Value::String(s)) => (s, false),
                Ok(v) => (serde_json::to_string_pretty(&v).unwrap_or_default(), false),
                Err(e) => (e, true),
            };
            json!({ "content": [{ "type": "text", "text": text }], "isError": is_error })
        }
        _ => {
            return Some(json!({ "jsonrpc": "2.0", "id": id,
                "error": { "code": -32601, "message": format!("Method not found: {method}") } }))
        }
    };
    Some(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
}

pub fn run_server() -> i32 {
    let args: Vec<String> = std::env::args().collect();
    let tab = args
        .iter()
        .position(|a| a == "--tab")
        .and_then(|i| args.get(i + 1))
        .cloned()
        .unwrap_or_default();
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    for line in stdin.lock().lines().map_while(Result::ok) {
        let Ok(msg) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        // Notifications carry no id and need no reply.
        if let Some(reply) = handle(&tab, &msg) {
            if writeln!(stdout, "{reply}").and_then(|_| stdout.flush()).is_err() {
                break;
            }
        }
    }
    0
}

/// `--mcp-config` JSON that attaches this server to a sidebar session.
pub fn session_config(tab: &str, sock: Option<&std::path::Path>) -> String {
    let exe = std::env::current_exe().unwrap_or_default().display().to_string();
    let mut env = serde_json::Map::new();
    if let Some(s) = sock {
        env.insert(SOCK_ENV.into(), json!(s.display().to_string()));
    }
    json!({
        "mcpServers": {
            crate::guard::TERM_SERVER: {
                "type": "stdio",
                "command": exe,
                "args": ["--mcp-server", "--tab", tab],
                "env": env
            }
        }
    })
    .to_string()
}
