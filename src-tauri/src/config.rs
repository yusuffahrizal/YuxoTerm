//! Persistent application settings stored in `~/.config/yuxoterm/config.json`.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

/// Per-agent settings (Claude Code, Codex, Gemini CLI, …), keyed by agent id.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct AgentSettings {
    /// Path to the agent's binary; empty means auto-detect from the login PATH.
    pub path: String,
    /// Default model for new chats; empty means the agent's own default.
    pub model: String,
    /// Default reasoning effort (low…max); empty means the agent's default.
    pub effort: String,
    /// Default extended thinking: "default", "on" or "off".
    pub thinking: String,
    /// Extra CLI arguments, whitespace separated.
    pub extra_args: String,
    /// Optional API key, passed in the agent's usual environment variable.
    pub api_key: String,
    /// Custom agent only: command line, with `{prompt}` where the message goes.
    pub command: String,
    /// Custom agent only: output format ("text", "claude", "gemini", "codex").
    pub format: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct AppConfig {
    /// UI language: "system", "en" or "id".
    pub language: String,
    /// Shell to launch in new panes; empty means `$SHELL`.
    pub shell: String,
    pub font_family: String,
    pub font_size: u16,
    /// Agent used by new chats.
    pub agent: String,
    pub agents: BTreeMap<String, AgentSettings>,
    /// `MAX_THINKING_TOKENS` when Claude's thinking is on; 0 means the default.
    pub thinking_budget: u32,
    /// Access level shared by all agents, named after Claude Code's
    /// `--permission-mode` values and mapped to each agent's own flags.
    pub permission_mode: String,
    /// Custom instructions added to every conversation, for every agent.
    pub append_system_prompt: String,
    // Pre-multi-agent Claude settings; read once to migrate into `agents`.
    #[serde(skip_serializing)]
    claude_path: String,
    #[serde(skip_serializing)]
    model: String,
    #[serde(skip_serializing)]
    effort: String,
    #[serde(skip_serializing)]
    thinking: String,
    #[serde(skip_serializing)]
    extra_args: String,
    #[serde(skip_serializing)]
    api_key: String,
    pub include_terminal_context: bool,
    pub context_lines: u32,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            language: "system".into(),
            shell: String::new(),
            font_family: "\"MesloLGS NF\", \"JetBrainsMono Nerd Font\", \"Symbols Nerd Font Mono\", \"JetBrains Mono\", \"SF Mono\", Menlo, monospace".into(),
            font_size: 13,
            agent: "claude".into(),
            agents: BTreeMap::new(),
            thinking_budget: 0,
            permission_mode: "bypassPermissions".into(),
            append_system_prompt: String::new(),
            claude_path: String::new(),
            model: String::new(),
            effort: String::new(),
            thinking: String::new(),
            extra_args: String::new(),
            api_key: String::new(),
            include_terminal_context: true,
            context_lines: 80,
        }
    }
}

/// Language the UI resolved ("en" or "id"), reported by the frontend at startup
/// so user-facing errors from the backend match the interface.
static UI_LANG: std::sync::RwLock<String> = std::sync::RwLock::new(String::new());

pub fn set_ui_lang(lang: &str) {
    *UI_LANG.write().unwrap() = lang.to_string();
}

/// Picks the English or Indonesian variant of a user-facing message.
pub fn tr(en: &str, id: &str) -> String {
    if UI_LANG.read().unwrap().as_str() == "id" {
        id.to_string()
    } else {
        en.to_string()
    }
}

/// `~/.config/yuxoterm`. Settings, rules and history from before the rename
/// (`~/.config/agentic-terminal`) are moved there the first time any process —
/// the app, the guard hook or the MCP server — needs the folder.
pub fn config_dir() -> PathBuf {
    static DIR: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
    DIR.get_or_init(|| {
        let base = dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")).join(".config");
        let dir = base.join("yuxoterm");
        let legacy = base.join("agentic-terminal");
        if !dir.exists() && legacy.is_dir() {
            let _ = fs::rename(&legacy, &dir);
        }
        // Holds the terminal-control socket, API keys and chat history: owner only.
        let _ = fs::create_dir_all(&dir);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&dir, fs::Permissions::from_mode(0o700));
        }
        dir
    })
    .clone()
}

pub fn config_path() -> PathBuf {
    config_dir().join("config.json")
}

/// Reads a JSON file, falling back to the type's default when missing or malformed.
pub fn read_json<T: for<'de> Deserialize<'de> + Default>(path: &PathBuf) -> T {
    fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// Writes JSON with owner-only permissions, since the config may hold an API key.
pub fn write_json<T: Serialize>(path: &PathBuf, value: &T) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let body = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    fs::write(path, body).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

pub fn load() -> AppConfig {
    let mut cfg: AppConfig = read_json(&config_path());
    if !cfg.agents.contains_key("claude") {
        cfg.agents.insert(
            "claude".into(),
            AgentSettings {
                path: std::mem::take(&mut cfg.claude_path),
                model: std::mem::take(&mut cfg.model),
                effort: std::mem::take(&mut cfg.effort),
                thinking: std::mem::take(&mut cfg.thinking),
                extra_args: std::mem::take(&mut cfg.extra_args),
                api_key: std::mem::take(&mut cfg.api_key),
                ..Default::default()
            },
        );
    }
    if cfg.agent.is_empty() {
        cfg.agent = "claude".into();
    }
    cfg
}

impl AppConfig {
    pub fn agent(&self, id: &str) -> AgentSettings {
        self.agents.get(id).cloned().unwrap_or_default()
    }
}

#[tauri::command]
pub fn get_config() -> AppConfig {
    load()
}

#[tauri::command]
pub fn save_config(config: AppConfig) -> Result<(), String> {
    write_json(&config_path(), &config)
}

#[derive(Serialize)]
pub struct FontFile {
    family: String,
    path: String,
    weight: &'static str,
    style: &'static str,
}

/// Locates user-installed font files for the given families. The webview only
/// exposes system fonts, so the UI registers these files itself via `FontFace`.
#[tauri::command]
pub fn resolve_fonts(families: Vec<String>) -> Vec<FontFile> {
    let norm = |s: &str| {
        s.to_lowercase()
            .chars()
            .filter(|c| c.is_alphanumeric())
            .collect::<String>()
    };
    let mut dirs_to_scan = vec![PathBuf::from("/Library/Fonts")];
    if let Some(home) = dirs::home_dir() {
        dirs_to_scan.insert(0, home.join("Library/Fonts"));
    }
    let mut out = Vec::new();
    for family in &families {
        let want = norm(family.trim_matches(|c| c == '"' || c == '\''));
        if want.is_empty() {
            continue;
        }
        for dir in &dirs_to_scan {
            let Ok(entries) = fs::read_dir(dir) else { continue };
            for entry in entries.flatten() {
                let path = entry.path();
                let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
                if !matches!(ext.as_str(), "ttf" | "otf") {
                    continue;
                }
                let stem = norm(path.file_stem().and_then(|s| s.to_str()).unwrap_or(""));
                let Some(rest) = stem.strip_prefix(&want) else { continue };
                // Only the four standard faces, so "Meslo" doesn't swallow "MesloLGM".
                let (weight, style) = match rest {
                    "" | "regular" => ("normal", "normal"),
                    "bold" => ("bold", "normal"),
                    "italic" => ("normal", "italic"),
                    "bolditalic" => ("bold", "italic"),
                    _ => continue,
                };
                out.push(FontFile {
                    family: family.trim_matches(|c| c == '"' || c == '\'').to_string(),
                    path: path.display().to_string(),
                    weight,
                    style,
                });
            }
        }
    }
    out
}
