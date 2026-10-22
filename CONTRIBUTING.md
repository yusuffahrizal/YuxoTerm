# Contributing to YuxoTerm

Thanks for your interest in improving YuxoTerm. This guide covers how to set up the project, what to check before opening a pull request, and how the main pieces fit together.

## Development setup

You need macOS, the [Rust](https://rustup.rs) stable toolchain with Clippy, the Xcode Command Line Tools, and Node.js 18 or later.

```bash
npm install
npm run dev
```

`npm run dev` copies xterm.js into `ui/vendor/` and starts the app with the Tauri dev runner. The UI is plain HTML, CSS and JavaScript modules with no bundler, so there is no frontend build step.

To try a change in the real app, install at least one supported agent (for example Claude Code) and sign in to it.

## Before you open a pull request

Run these from `src-tauri/`:

```bash
cargo fmt
cargo clippy --all-targets   # should report no warnings
cargo test
```

Then check the change by hand in the running app. For UI changes, include a screenshot in the pull request. For agent-related changes, say which agent and version you tested with.

Keep pull requests focused on one change, and describe *why* the change is needed as well as what it does.

## Code style

- **Rust:** follow `rustfmt` and Clippy. Return errors to the UI as `Result<_, String>` with a message the user can act on. Never panic in a Tauri command.
- **JavaScript:** modern ES modules with no framework. Keep DOM helpers small and local. Escape any text that comes from an agent or the shell before inserting it as HTML (see `esc()` and `renderMarkdown()` in `ui/app.js`).
- **Comments:** explain *why* something is done when it isn't obvious from the code. Match the density of the surrounding code.
- **Commands that read files or run processes** go off the UI thread: use an `async` Tauri command with `spawn_blocking`.

## User-facing text

All interface text lives in `ui/i18n.js`, in both English (`en`) and Indonesian (`id`).

- Add every new string to **both** languages.
- In markup, use the `data-i18n`, `data-i18n-placeholder`, `data-i18n-title` or `data-i18n-html` attributes. In code, use `t("key", { vars })`.
- Backend messages shown to the user use `config::tr("English", "Indonesian")`.
- Text that the *agent* reads (tool results, guard reasons, the system prompt) stays in English.

## Adding a new agent

1. **Backend:** in `src-tauri/src/agents.rs`:
   - Add a `Spec` with the binary name, install hint, API-key environment variable, and guard coverage.
   - Add a `build_<agent>` function that maps the request onto the agent's flags: prompt, model, effort, thinking, access level, and resume.
   - Add the terminal tools and the guard hook for the run if the agent allows it. Prefer per-run mechanisms (flags, environment variables, temporary files) over editing the user's configuration.
2. **Guard:** if the agent uses its own tool names, map them in `rule_tool_name()` and `subject_for()` in `src-tauri/src/guard.rs`, and add a test case.
3. **UI:** add the agent to `AGENTS` in `ui/agents.js`. If its output format is new, add an adapter that converts it into the Claude Code stream-json shape the chat understands. The existing adapters show the pattern.
4. **Docs:** update the agent table in `README.md`.

Base flags and event formats on the agent's documentation or its `--help` output, not on memory, and note the version you checked.

## Reporting bugs

Open an issue and include:

- Your macOS version and YuxoTerm version
- The agent and its version, if the bug involves one
- Steps to reproduce, what you expected, and what happened instead
- Relevant lines from `~/.config/yuxoterm/guard.log`, if the bug involves Command Guard

For security problems, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.
