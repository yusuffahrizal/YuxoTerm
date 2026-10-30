#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod agents;
mod clipboard;
mod config;
mod guard;
mod history;
mod mcp;
mod pty;
mod shellenv;
mod sshconfig;

use std::sync::Arc;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{Emitter, Manager, RunEvent};

fn main() {
    // The same binary doubles as the Claude Code PreToolUse hook and the
    // terminal-control MCP server.
    if std::env::args().any(|a| a == "--guard-hook") {
        std::process::exit(guard::run_hook());
    }
    if std::env::args().any(|a| a == "--mcp-server") {
        std::process::exit(mcp::run_server());
    }

    let broker = Arc::new(guard::AskBroker::default());
    let app = tauri::Builder::default()
        .manage(pty::PtyState::default())
        .manage(agents::AgentState::default())
        .manage(broker.clone())
        .setup(move |app| {
            guard::start_broker(app.handle().clone(), broker);
            // Resolve the login PATH off the UI thread so the first prompt is fast.
            std::thread::spawn(|| {
                shellenv::login_path();
                guard::refresh_global();
                agents::refresh_global_tools();
                history::prewarm();
            });
            app.set_menu(build_menu(app.handle())?)?;
            app.on_menu_event(|app, event| {
                let _ = app.emit("menu", event.id().0.as_str());
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            config::get_config,
            config::save_config,
            config::resolve_fonts,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_cwd,
            pty::pty_foreground,
            sshconfig::ssh_hosts,
            shellenv::shells_available,
            clipboard::clipboard_read,
            clipboard::clipboard_write,
            agents::agent_send,
            agents::agent_cancel,
            agents::agents_status,
            agents::claude_models,
            agents::agent_interactive_command,
            agents::agent_tools_install,
            guard::get_guard,
            guard::save_guard,
            guard::reset_guard,
            guard::test_guard,
            guard::guard_respond,
            guard::agent_tool_result,
            set_ui_language,
            guard::guard_info,
            guard::guard_install_global,
            history::history_list,
            history::history_load,
            history::history_delete,
            history::history_record,
            open_url,
        ])
        .build(tauri::generate_context!())
        .expect("failed to build YuxoTerm");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            guard::cleanup_broker(&handle.state::<Arc<guard::AskBroker>>());
        }
    });
}

/// Called by the UI once it has resolved its language; localizes backend
/// messages and the native menu.
#[tauri::command]
fn set_ui_language(app: tauri::AppHandle, lang: String) -> Result<(), String> {
    config::set_ui_lang(&lang);
    let menu = build_menu(&app).map_err(|e| e.to_string())?;
    app.set_menu(menu).map_err(|e| e.to_string())?;
    Ok(())
}

/// Opens http(s) links from terminal output and chat in the default browser.
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err(config::tr(
            "Only web links (http/https) can be opened.",
            "Hanya tautan web (http/https) yang bisa dibuka.",
        ));
    }
    #[cfg(target_os = "macos")]
    let opener = "open";
    #[cfg(not(target_os = "macos"))]
    let opener = "xdg-open";
    std::process::Command::new(opener)
        .arg(&url)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Custom menu: keeps native copy/paste but leaves ⌘T/⌘W/⌘D to the terminal UI.
fn build_menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let sep = || PredefinedMenuItem::separator(app);
    let app_menu = Submenu::with_items(
        app,
        "YuxoTerm",
        true,
        &[
            &PredefinedMenuItem::about(app, None, None)?,
            &sep()?,
            &MenuItem::with_id(
                app,
                "settings",
                config::tr("Settings…", "Pengaturan…"),
                true,
                Some("CmdOrCtrl+,"),
            )?,
            &sep()?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &sep()?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        config::tr("Edit", "Edit"),
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &sep()?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let window = Submenu::with_items(
        app,
        config::tr("Window", "Jendela"),
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::fullscreen(app, None)?,
        ],
    )?;
    Menu::with_items(app, &[&app_menu, &edit, &window])
}
