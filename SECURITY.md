# Security

YuxoTerm runs coding agents that can execute commands, edit files and type into your terminal. This page explains what protects you, what does not, and how to report a vulnerability.

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Report them privately through GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability) on this repository (the **Security** tab → **Report a vulnerability**).

Include the YuxoTerm version, the agent involved (if any), and steps to reproduce. You will get an acknowledgement as soon as possible, and a fix or mitigation will be coordinated with you before details are made public.

## Security model

### What agents can do

With the default **Full access** mode, an agent can do anything your macOS user account can: read and write your files, run any program, and use the network. YuxoTerm does not sandbox agents. Lower access modes (Settings → Agents → Access) are passed on to each agent's own permission system.

### What Command Guard does

Command Guard checks tool calls against your rules before they run, and allows, asks about, or blocks them. Coverage depends on the agent:

- **Claude Code, Codex, Gemini CLI, OpenCode:** every tool call, through the agent's pre-tool hook
- **Antigravity, Cursor Agent:** only commands typed into your panes through YuxoTerm's terminal tools
- **Custom agents:** none

### What Command Guard does not do

- **It is a guardrail, not a security boundary.** Rules are regular expressions matched against command text and file paths. An agent can reach the same result in a way your rules don't anticipate, for example a script that deletes files, or an encoded command.
- **It does not cover actions an agent takes outside its tools**, such as code it writes into a file that you later run.
- **If the hook receives input it cannot read, the call is allowed.** This keeps agents working when they change their hook format. Actions that need approval are denied when YuxoTerm isn't running, except for Claude Code, which shows its own prompt.

Treat agent output like any other code you didn't write. Review changes, keep secrets out of reach where you can, and prefer lower access modes for unfamiliar projects.

## How YuxoTerm protects its own channels

- **App socket:** the guard hook and the MCP server talk to the app over a Unix socket in `~/.config/yuxoterm/run/`. The folder is readable only by your user account (mode 700).
- **Configuration:** settings, which may include API keys, are stored with file mode 600. Keys are passed to agents only as environment variables.
- **WebView:** the interface runs with a Content Security Policy that only allows the app's own scripts. Agent output is escaped before it is rendered.
- **Links:** only `http` and `https` links are opened, in your default browser.
- **Your other configuration files:** YuxoTerm edits files outside its own folder (`~/.claude/settings.json`, and the Antigravity and Cursor MCP files) only when you turn on the option that says so. It changes only its own entries and leaves everything else as it was.
