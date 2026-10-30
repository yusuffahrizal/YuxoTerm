// YuxoTerm UI: tabs → split panes (xterm.js on a Rust PTY) + Claude sidebar.
import { t, applyI18n, setLanguage, setKeyLabeler, resolveLanguage, LANGUAGES, ruleName, ruleNameKey, locale } from "./i18n.js";
import { AGENTS, agentInfo, canonModel, createAdapter, effortsFor, FORMATS, pickEffort, setClaudeModels } from "./agents.js";
import { IS_MAC, matchShortcut, shortcutLabel, shortcutParts, shortcutRange } from "./keys.js";
import { $, basename, el, esc, invoke } from "./util.js";
import { LOCAL, defaultProfile, profileMenuEntries, profileName, renderProfileSettings, resolveProfile } from "./profiles.js";

const { listen } = window.__TAURI__.event;
const appWindow = window.__TAURI__.window.getCurrentWindow();

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

// Terminal colors: background and cursor come from the logo; the ANSI hues are the
// same family (Tailwind 300–500) so program output sits comfortably next to the UI.
const THEME = {
  background: "#0e1116", foreground: "#f3f5f7", cursor: "#5eead4", cursorAccent: "#0e1116",
  selectionBackground: "rgba(94, 234, 212, 0.24)", selectionInactiveBackground: "rgba(94, 234, 212, 0.12)",
  black: "#171c24", red: "#f87171", green: "#4ade80", yellow: "#fbbf24", blue: "#60a5fa",
  magenta: "#c084fc", cyan: "#2dd4bf", white: "#cbd5e1",
  brightBlack: "#667384", brightRed: "#fca5a5", brightGreen: "#86efac", brightYellow: "#fcd34d",
  brightBlue: "#93c5fd", brightMagenta: "#d8b4fe", brightCyan: "#5eead4", brightWhite: "#f3f5f7",
};

let config = null;
let seq = 0;
const nextId = (p) => `${p}${++seq}`;
const panes = new Map(); // pane id → Pane
const tabs = [];
let activeTab = null;
const runs = new Map(); // claude run id → Chat

// ---------------------------------------------------------------------------
// Pane: one xterm.js instance bound to one PTY
// ---------------------------------------------------------------------------
class Pane {
  constructor(tab) {
    this.tab = tab;
    this.id = nextId("p");
    this.el = el("div", "pane");
    this.title = "";
    this.customTitle = "";
    this.readOnly = false;
    this.cwd = null;
    this.alive = false;
    // The profile this pane was started from; set by start().
    this.profile = null;
    // Badges in the corners of the pane: who is driving it, whether it is locked, its custom title.
    this.tagAgent = el("span", "tag tag-agent");
    this.tagReadOnly = el("span", "tag tag-ro");
    this.titleChip = el("div", "pane-title-chip");
    this.el.append(el("div", "pane-tags", null), this.titleChip);
    $(".pane-tags", this.el).append(this.tagAgent, this.tagReadOnly);
    this.updateTags();
    this.term = new Terminal({
      fontFamily: config.font_family,
      fontSize: config.font_size,
      lineHeight: 1.15,
      theme: THEME,
      cursorBlink: true,
      allowProposedApi: true,
      macOptionIsMeta: true,
      scrollback: 10000,
      drawBoldTextInBrightColors: false,
      // OSC 8 hyperlinks (what CLIs like Claude Code print for login URLs). xterm's default handler
      // relies on confirm() and window.open(), neither of which works inside the webview.
      linkHandler: { activate: (_, uri) => invoke("open_url", { url: uri }).catch(() => {}), allowNonHttpProtocols: false },
    });
    this.fit = new FitAddon.FitAddon();
    this.term.loadAddon(this.fit);
    this.term.loadAddon(new WebLinksAddon.WebLinksAddon((_, uri) => invoke("open_url", { url: uri })));
    panes.set(this.id, this);

    // Read-only blocks typing and pasting but not the terminal's own replies to programs.
    this.term.attachCustomKeyEventHandler(() => !this.readOnly);
    this.el.addEventListener("paste", (e) => { if (this.readOnly) { e.preventDefault(); e.stopPropagation(); } }, true);
    this.term.onData((data) => {
      if (!this.alive) return;
      invoke("pty_write", { id: this.id, data });
      if (data.includes("\r")) setTimeout(() => this.refreshCwd(), 400);
    });
    this.term.onTitleChange((title) => { this.title = title; this.tab.renderHeader(); });
    this.el.addEventListener("mousedown", () => this.tab.focusPane(this, false));

    let raf = 0;
    this.resizeObs = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => this.doFit());
    });
    this.resizeObs.observe(this.el);
  }

  updateTags() {
    this.tagAgent.textContent = `✦ ${t("tag.agent")}`;
    this.tagReadOnly.textContent = t("tag.readOnly");
    this.titleChip.textContent = this.customTitle;
    this.titleChip.hidden = !this.customTitle;
    this.el.classList.toggle("titled", !!this.customTitle);
    this.doFit();
  }

  setReadOnly(on) {
    this.readOnly = on;
    this.el.classList.toggle("readonly", on);
    this.doFit();
  }

  async start(cwd, initialCommand, profileId) {
    this.profile = resolveProfile(config, profileId ?? defaultProfile(config).id);
    // Until the remote shell sets its own title, an SSH pane is named after its host.
    if (this.profile.kind === "ssh") this.title = this.profile.ssh_host;
    this.term.open(this.el);
    this.term.textarea?.addEventListener("focus", () => this.tab.focusPane(this, false));
    try {
      const gl = new WebglAddon.WebglAddon();
      gl.onContextLoss(() => gl.dispose());
      this.term.loadAddon(gl);
    } catch { /* falls back to the DOM renderer */ }
    this.doFit();
    this.cwd = cwd || null;
    this.ptyCols = this.term.cols;
    this.ptyRows = this.term.rows;
    await invoke("pty_spawn", { id: this.id, cwd: cwd || null, cols: this.ptyCols, rows: this.ptyRows, profile: this.profile.id });
    this.alive = true;
    if (initialCommand) setTimeout(() => invoke("pty_write", { id: this.id, data: initialCommand + "\r" }), 350);
    this.refreshCwd();
  }

  doFit() {
    if (!this.el.isConnected || this.el.clientWidth < 20 || this.el.clientHeight < 20) return;
    try { this.fit.fit(); } catch { return; }
    // Every PTY resize makes the shell redraw its prompt, so only send the size
    // once a drag or window resize settles.
    clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => {
      const { cols, rows } = this.term;
      if (!this.alive || (cols === this.ptyCols && rows === this.ptyRows)) return;
      this.ptyCols = cols;
      this.ptyRows = rows;
      invoke("pty_resize", { id: this.id, cols, rows });
    }, 120);
  }

  async refreshCwd() {
    const cwd = await invoke("pty_cwd", { id: this.id }).catch(() => null);
    if (cwd && cwd !== this.cwd) {
      this.cwd = cwd;
      this.tab.renderHeader();
      if (this.tab === activeTab && this.tab.activePane === this) updateSidebarCwd();
    }
  }

  // Recent visible text, used as context for Claude.
  snapshot(maxLines) {
    const buf = this.term.buffer.active;
    const end = buf.baseY + buf.cursorY + 1;
    const start = Math.max(0, end - maxLines);
    const lines = [];
    for (let i = start; i < end; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? "");
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    while (lines.length && !lines[0].trim()) lines.shift();
    return lines.join("\n");
  }

  dispose() {
    this.resizeObs.disconnect();
    if (this.alive) invoke("pty_kill", { id: this.id });
    this.alive = false;
    this.term.dispose();
    panes.delete(this.id);
  }
}

// ---------------------------------------------------------------------------
// Tab: a tree of splits whose leaves are panes, plus its own Claude chat
// ---------------------------------------------------------------------------
class Tab {
  constructor() {
    this.id = nextId("t");
    this.root = el("div", "tab-root");
    this.panes = [];
    this.activePane = null;
    this.customTitle = "";
    this.chat = new Chat(this);
    this.header = el("div", "tab");
    this.header.innerHTML = `<span class="tab-title"></span><span class="tab-kind"></span><span class="tab-count"></span><button class="tab-close" data-i18n-title="tab.close">×</button>`;
    applyI18n(this.header);
    this.header.addEventListener("mousedown", (e) => { if (!e.target.closest(".tab-close")) activateTab(this); });
    this.header.addEventListener("auxclick", (e) => { if (e.button === 1) closeTab(this); });
    $(".tab-close", this.header).addEventListener("click", () => closeTab(this));
    $("#workspace").append(this.root);
    $("#tabs").append(this.header);
  }

  async addFirstPane(cwd, cmd, profile) {
    const pane = new Pane(this);
    this.root.append(pane.el);
    this.panes.push(pane);
    this.activePane = pane;
    this.renderHeader();
    await pane.start(cwd, cmd, profile);
    this.focusPane(pane);
  }

  // dir: "row" places the new pane right of `pane`, "col" places it below.
  // `before` puts the new pane left of / above `pane` instead of right of / below it.
  async split(pane, dir, cmd, { cwd = null, focus = true, before = false, profile } = {}) {
    cwd ||= (await invoke("pty_cwd", { id: pane.id }).catch(() => null)) || pane.cwd;
    const next = new Pane(this);
    const parent = pane.el.parentElement;
    const box = el("div", `split ${dir}`);
    box.style.flex = pane.el.style.flex || "1 1 0";
    pane.el.style.flex = "1 1 0";
    next.el.style.flex = "1 1 0";
    parent.replaceChild(box, pane.el);
    if (before) box.append(next.el, makeDivider(dir), pane.el);
    else box.append(pane.el, makeDivider(dir), next.el);
    this.panes.splice(this.panes.indexOf(pane) + (before ? 0 : 1), 0, next);
    this.updateMulti();
    await next.start(cwd, cmd, profile);
    if (focus) this.focusPane(next);
    return next;
  }

  closePane(pane) {
    const idx = this.panes.indexOf(pane);
    if (idx < 0) return;
    this.panes.splice(idx, 1);
    const parent = pane.el.parentElement;
    pane.dispose();
    if (parent === this.root) {
      pane.el.remove();
      closeTab(this);
      return;
    }
    const sibling = [...parent.children].find((c) => c !== pane.el && !c.classList.contains("divider"));
    sibling.style.flex = parent.style.flex || "1 1 0";
    parent.replaceWith(sibling);
    this.updateMulti();
    if (this.activePane === pane) this.focusPane(this.panes[Math.max(0, idx - 1)]);
  }

  updateMulti() {
    this.root.classList.toggle("multi", this.panes.length > 1);
    this.renderHeader();
  }

  focusPane(pane, focusTerm = true) {
    if (!pane) return;
    const changed = this.activePane !== pane;
    this.activePane = pane;
    for (const p of this.panes) p.el.classList.toggle("focused", p === pane);
    if (focusTerm) pane.term.focus();
    if (changed) {
      this.renderHeader();
      if (this === activeTab) updateSidebarCwd();
    }
  }

  cyclePane(delta) {
    const i = this.panes.indexOf(this.activePane);
    this.focusPane(this.panes[(i + delta + this.panes.length) % this.panes.length]);
  }

  // Moves focus to the nearest pane in a screen direction.
  focusDirection(dx, dy) {
    const from = this.activePane.el.getBoundingClientRect();
    const cx = from.left + from.width / 2, cy = from.top + from.height / 2;
    let best = null, bestScore = Infinity;
    for (const p of this.panes) {
      if (p === this.activePane) continue;
      const r = p.el.getBoundingClientRect();
      const ok = dx > 0 ? r.left >= from.right - 2 : dx < 0 ? r.right <= from.left + 2 : dy > 0 ? r.top >= from.bottom - 2 : r.bottom <= from.top + 2;
      if (!ok) continue;
      const px = r.left + r.width / 2, py = r.top + r.height / 2;
      const score = dx ? Math.abs(px - cx) + 2 * Math.abs(py - cy) : 2 * Math.abs(px - cx) + Math.abs(py - cy);
      if (score < bestScore) { best = p; bestScore = score; }
    }
    if (best) this.focusPane(best);
  }

  renderHeader() {
    const p = this.activePane;
    const title = this.customTitle || (p && (p.customTitle || p.title || basename(p.cwd))) || t("tab.fallback");
    $(".tab-title", this.header).textContent = title;
    this.header.title = p?.cwd || title;
    const kind = $(".tab-kind", this.header);
    kind.textContent = p?.profile?.kind === "ssh" ? "ssh" : "";
    const count = $(".tab-count", this.header);
    count.textContent = this.panes.length > 1 ? `⧉${this.panes.length}` : "";
    count.title = t("tab.panes", { n: this.panes.length });
    let busy = $(".tab-busy", this.header);
    if (this.chat.busy && !busy) this.header.prepend(el("span", "tab-busy"));
    if (!this.chat.busy && busy) busy.remove();
  }
}

function makeDivider(dir) {
  const d = el("div", "divider");
  d.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const box = d.parentElement;
    const [a, , b] = box.children;
    const rect = box.getBoundingClientRect();
    const horizontal = dir === "row";
    d.classList.add("dragging");
    document.body.classList.add(horizontal ? "resizing-col" : "resizing-row");
    const move = (ev) => {
      const pos = horizontal ? (ev.clientX - rect.left) / rect.width : (ev.clientY - rect.top) / rect.height;
      const ratio = Math.min(0.9, Math.max(0.1, pos));
      a.style.flex = `${ratio} 1 0`;
      b.style.flex = `${1 - ratio} 1 0`;
    };
    const up = () => {
      d.classList.remove("dragging");
      document.body.classList.remove("resizing-col", "resizing-row");
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  });
  return d;
}

const AUTH_ERROR = /\/login|not logged in|invalid api key|authentication[_ ]error|oauth|token (has )?expired|\b401\b/i;

// `profile` is a profile id; without one the tab uses the default profile. Programmatic opens
// (agent tools, login, resumed chats) pass LOCAL because they expect a local shell.
async function newTab(cwd, cmd, { activate = true, profile } = {}) {
  const tab = new Tab();
  tabs.push(tab);
  if (activate) activateTab(tab);
  else tab.root.classList.add("hidden");
  try {
    await tab.addFirstPane(cwd ?? activeTabCwd(), cmd, profile);
  } catch (e) {
    // Don't leave a dead tab behind, and don't close the window if it was the only one.
    // xterm has a render queued after open(); disposing it before that runs throws.
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    closeTab(tab, { keepWindow: true });
    throw e;
  }
  if (!activate) activeTab?.activePane?.term.focus();
  return tab;
}

// User-initiated new tab: failures (missing ssh, bad command) are shown instead of thrown.
async function openTab(profile) {
  try {
    await newTab(undefined, undefined, { profile });
  } catch (e) {
    toast(String(e?.message ?? e), "error");
    if (!tabs.length) await newTab(null, undefined, { profile: LOCAL });
  }
}

function activeTabCwd() {
  return activeTab?.activePane?.cwd ?? null;
}

function activateTab(tab) {
  if (!tab) return;
  activeTab = tab;
  for (const other of tabs) {
    other.root.classList.toggle("hidden", other !== tab);
    other.header.classList.toggle("active", other === tab);
  }
  $("#chat-host").replaceChildren(tab.chat.log);
  tab.chat.syncComposer();
  updateSidebarCwd();
  tab.header.scrollIntoView({ inline: "nearest" });
  requestAnimationFrame(() => {
    for (const p of tab.panes) p.doFit();
    tab.activePane?.term.focus();
  });
}

function closeTab(tab, { keepWindow = false } = {}) {
  const i = tabs.indexOf(tab);
  if (i < 0) return;
  tab.chat.cancel();
  for (const p of [...tab.panes]) p.dispose();
  tab.root.remove();
  tab.header.remove();
  tabs.splice(i, 1);
  if (!tabs.length) {
    activeTab = null;
    if (!keepWindow) appWindow.close();
    return;
  }
  if (activeTab === tab) activateTab(tabs[Math.min(i, tabs.length - 1)]);
}

// ---------------------------------------------------------------------------
// Claude chat (one per tab), driven by `claude -p --output-format stream-json`
// ---------------------------------------------------------------------------
class Chat {
  constructor(tab) {
    this.tab = tab;
    this.log = el("div", "chat-log");
    this.sessionId = null;
    this.runId = null;
    this.busy = false;
    this.tools = new Map();
    this.streamedMsgs = new Set();
    this.live = null;
    this.liveThink = null;
    this.sessionCwd = null;
    // { agent, model, effort, thinking } used by this tab's next message.
    this.agent = agentDefaults();
    // Set once the user picks an agent/model/effort/thinking for this tab, so
    // later changes to the defaults in Settings don't override their choice.
    this.agentCustom = false;
    // Agent the current session belongs to; switching agents starts a new one.
    this.sessionAgent = null;
    this.adapter = null;
    // History entries waiting for the agent to report its session id.
    this.pendingRecord = [];
    this.renderEmpty();
  }

  renderEmpty() {
    const name = agentInfo(this.agent.agent).short;
    this.log.innerHTML = `<div class="chat-empty"><div class="big">✦</div>
      <p class="ce-title">${esc(t("empty.title", { agent: name }))}</p>
      <p>${esc(t("empty.body", { agent: name }))}</p>
      <p class="ce-note">${esc(t("empty.guard"))}</p></div>`;
  }

  // Non-Claude conversations are recorded by the app (Claude Code keeps its own).
  record(entry) {
    if ((this.sessionAgent ?? this.agent.agent) === "claude") return;
    if (!this.sessionId) { this.pendingRecord.push(entry); return; }
    const entries = [...this.pendingRecord, entry];
    this.pendingRecord = [];
    invoke("history_record", { agent: this.sessionAgent, sessionId: this.sessionId, cwd: this.sessionCwd ?? "", entries }).catch(() => {});
  }

  flushRecord() {
    if (!this.pendingRecord.length || !this.sessionId) return;
    const entries = this.pendingRecord;
    this.pendingRecord = [];
    if (this.sessionAgent === "claude") return;
    invoke("history_record", { agent: this.sessionAgent, sessionId: this.sessionId, cwd: this.sessionCwd ?? "", entries }).catch(() => {});
  }

  reset() {
    this.cancel();
    this.sessionId = null;
    this.sessionCwd = null;
    this.sessionAgent = null;
    this.pendingRecord = [];
    this.tools.clear();
    this.streamedMsgs.clear();
    this.live = null;
    this.liveThink = null;
    this.renderEmpty();
    if (this.tab === activeTab) updateSidebarCwd();
  }

  // Replays a saved Claude Code transcript and continues it on the next prompt.
  loadSession(session) {
    this.reset();
    this.log.replaceChildren();
    this.sessionId = session.id;
    this.sessionCwd = session.cwd || null;
    this.sessionAgent = session.agent || "claude";
    if (this.agent.agent !== this.sessionAgent) {
      this.agent = agentDefaults(this.sessionAgent);
      this.agentCustom = true;
    }
    this.append(el("div", "meta", `${t("chat.historyMeta", { title: session.title || t("chat.untitled") })} · ${agentInfo(this.sessionAgent).name} · ${session.cwd}`));
    for (const entry of session.entries) {
      if (entry.type === "assistant") { this.onAssistant(entry.message); continue; }
      const content = entry.message?.content;
      const hasResult = Array.isArray(content) && content.some((b) => b.type === "tool_result");
      if (hasResult) { this.onUser(entry.message); continue; }
      const text = typeof content === "string" ? content : (content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
      this.append(userBubble(text));
    }
    for (const card of this.tools.values()) {
      if (!card.classList.contains("err")) card.classList.add("ok");
    }
    this.append(el("div", "meta result", `↻ ${t("chat.resumed")}`));
    this.log.scrollTop = this.log.scrollHeight;
    if (this.tab === activeTab) updateSidebarCwd();
  }

  append(node) {
    $(".chat-empty", this.log)?.remove();
    const stick = this.log.scrollHeight - this.log.scrollTop - this.log.clientHeight < 60;
    this.log.append(node);
    if (stick) this.log.scrollTop = this.log.scrollHeight;
    return node;
  }

  scrollIfNear() {
    if (this.log.scrollHeight - this.log.scrollTop - this.log.clientHeight < 120) this.log.scrollTop = this.log.scrollHeight;
  }

  setBusy(busy) {
    this.busy = busy;
    this.tab.renderHeader();
    if (this.tab === activeTab) this.syncComposer();
  }

  syncComposer() {
    const send = $("#send");
    send.textContent = this.busy ? t("composer.stop") : t("composer.send");
    send.classList.toggle("stop", this.busy);
    $("#status-line").classList.toggle("hidden", !this.busy);
    updateAgentButton();
  }

  async send(text) {
    if (this.busy || !text.trim()) return;
    const pane = this.tab.activePane;
    // A resumed session must run in its own directory, or Claude can't find it.
    const paneCwd = (await invoke("pty_cwd", { id: pane.id }).catch(() => null)) || pane.cwd;
    const cwd = this.sessionId && this.sessionCwd ? this.sessionCwd : paneCwd;
    let prompt = text;
    const bubble = userBubble(text);
    if ($("#ctx-toggle").checked) {
      const snap = pane.snapshot(config.context_lines || 80);
      if (snap) {
        prompt = `<terminal cwd="${cwd ?? ""}">\n${snap}\n</terminal>\n\n${text}`;
        bubble.append(el("span", "ctx-chip", t("chat.contextChip", { n: snap.split("\n").length })));
      }
    }
    this.append(bubble);
    this.log.scrollTop = this.log.scrollHeight;
    const { agent, model, effort, thinking } = this.agent;
    const info = agentInfo(agent);
    this.sessionAgent = agent;
    this.runId = nextId("r");
    this.sawResult = false;
    this.adapter = createAdapter(info.custom ? (config.agents?.custom?.format || "text") : info.format, {
      agentName: info.name, model, cwd, prefix: this.runId,
    });
    runs.set(this.runId, this);
    this.record({ type: "user", message: { role: "user", content: prompt } });
    this.setBusy(true);
    setStatus(t("status.thinking"));
    try {
      await invoke("agent_send", { args: { run_id: this.runId, tab_id: this.tab.id, agent, prompt, cwd, resume: this.sessionId, model, effort, thinking } });
    } catch (e) {
      this.append(el("div", "error-box", String(e)));
      runs.delete(this.runId);
      this.runId = null;
      this.setBusy(false);
    }
  }

  cancel() {
    if (this.runId) invoke("agent_cancel", { runId: this.runId });
  }

  // One raw output line from the agent process.
  handleLine(line) {
    for (const ev of this.adapter?.push(line) ?? []) this.handle(ev);
  }

  handle(ev) {
    switch (ev.type) {
      case "system":
        if (ev.subtype === "init") {
          const isNew = this.sessionId !== ev.session_id;
          this.sessionId = ev.session_id;
          this.sessionCwd = ev.cwd ?? this.sessionCwd;
          this.flushRecord();
          if (this.tab === activeTab) updateSidebarCwd();
          if (isNew) this.append(el("div", "meta", [agentInfo(this.sessionAgent).name, ev.model, ev.cwd].filter(Boolean).join(" · ")));
        }
        break;
      case "stream_event":
        this.onStream(ev.event);
        break;
      case "assistant":
        this.onAssistant(ev.message);
        this.record({ type: "assistant", message: ev.message });
        break;
      case "user":
        this.onUser(ev.message);
        if (Array.isArray(ev.message?.content) && ev.message.content.some((b) => b.type === "tool_result")) {
          this.record({ type: "user", message: ev.message });
        }
        break;
      case "agent_error":
        this.append(el("div", "error-box", ev.text));
        break;
      case "agent_warning":
        this.append(el("div", "meta warn", `⚠︎ ${ev.text}`));
        break;
      case "agent_status":
        setStatus(ev.text);
        break;
      case "result":
        this.onResult(ev);
        break;
    }
  }

  onStream(e) {
    if (!e) return;
    if (e.type === "message_start" && e.message?.id) this.streamedMsgs.add(e.message.id);
    else if (e.type === "content_block_start" && e.content_block?.type === "text") {
      this.live = { raw: "", node: this.append(el("div", "msg-text")), raf: 0 };
      setStatus(t("status.writing"));
    } else if (e.type === "content_block_start" && e.content_block?.type === "thinking") {
      setStatus(t("status.thinking"));
      const node = this.append(thinkingBlock("", true));
      this.liveThink = { raw: "", node, body: $(".th-body", node), raf: 0 };
    } else if (e.type === "content_block_delta" && e.delta?.type === "thinking_delta" && this.liveThink) {
      const live = this.liveThink;
      live.raw += e.delta.thinking;
      if (!live.raf) live.raf = requestAnimationFrame(() => {
        live.raf = 0;
        live.body.textContent = live.raw;
        live.body.scrollTop = live.body.scrollHeight;
        this.scrollIfNear();
      });
    } else if (e.type === "content_block_stop" && this.liveThink) {
      this.finishThinking();
    } else if (e.type === "content_block_delta" && e.delta?.type === "text_delta" && this.live) {
      const live = this.live;
      live.raw += e.delta.text;
      if (!live.raf) live.raf = requestAnimationFrame(() => {
        live.raf = 0;
        live.node.innerHTML = renderMarkdown(live.raw);
        this.scrollIfNear();
      });
    } else if (e.type === "content_block_stop" && this.live) {
      cancelAnimationFrame(this.live.raf);
      this.live.node.innerHTML = renderMarkdown(this.live.raw);
      this.live = null;
    }
  }

  finishThinking() {
    const live = this.liveThink;
    if (!live) return;
    cancelAnimationFrame(live.raf);
    live.body.textContent = live.raw;
    live.node.classList.remove("live");
    live.node.open = false;
    if (!live.raw.trim()) live.node.remove();
    this.liveThink = null;
  }

  onAssistant(msg) {
    const streamed = msg?.id && this.streamedMsgs.has(msg.id);
    for (const block of msg?.content ?? []) {
      if (block.type === "thinking" && !streamed && block.thinking?.trim()) {
        this.append(thinkingBlock(block.thinking, false));
      } else if (block.type === "text" && !streamed && block.text) {
        const n = el("div", "msg-text");
        n.innerHTML = renderMarkdown(block.text);
        this.append(n);
      } else if (block.type === "tool_use" && !this.tools.has(block.id)) {
        this.tools.set(block.id, this.append(toolCard(block)));
        setStatus(t("status.running", { tool: toolLabel(block.name) }));
      }
    }
  }

  onUser(msg) {
    const content = Array.isArray(msg?.content) ? msg.content : [];
    for (const block of content) {
      if (block.type !== "tool_result") continue;
      const card = this.tools.get(block.tool_use_id);
      if (!card) continue;
      const text = toolResultText(block.content);
      card.classList.add(block.is_error ? "err" : "ok");
      if (block.is_error && /guard/i.test(text)) {
        card.classList.add("blocked");
        $("summary", card).append(el("span", "t-flag", t("tool.blocked")));
      }
      card.append(el("div", "t-label", t("tool.output")), el("pre", null, text.length > 6000 ? text.slice(0, 6000) + "\n…" : text));
      if (block.is_error) card.open = true;
    }
    setStatus(t("status.thinking"));
  }

  // Headless runs can't do OAuth, so an auth failure gets a button that finishes the login in a terminal tab.
  appendError(text) {
    const box = el("div", "error-box", text);
    if ((this.sessionAgent ?? this.agent.agent) === "claude" && AUTH_ERROR.test(text)) {
      const btn = el("button", "ghost-btn", t("chat.loginClaude"));
      btn.style.cssText = "display:block;margin-top:8px";
      btn.addEventListener("click", () => newTab(activeTabCwd(), "claude auth login", { profile: LOCAL }));
      box.append(btn);
    }
    this.append(box);
  }

  onResult(ev) {
    this.sawResult = true;
    if (ev.session_id) this.sessionId = ev.session_id;
    const secs = ev.duration_ms ? `${(ev.duration_ms / 1000).toFixed(1)}s` : "";
    const cost = ev.total_cost_usd != null ? `$${ev.total_cost_usd.toFixed(4)}` : "";
    const turns = ev.num_turns ? (ev.num_turns === 1 ? t("chat.turn") : t("chat.turns", { n: ev.num_turns })) : "";
    const failed = ev.is_error || ev.subtype !== "success";
    if (failed) this.appendError(ev.result || t("chat.agentFailed"));
    this.append(el("div", "meta result", [failed ? `✕ ${t("chat.failed")}` : `✓ ${t("chat.done")}`, secs, turns, cost].filter(Boolean).join(" · ")));
  }

  onDone({ code, stderr }) {
    for (const ev of this.adapter?.finish(code) ?? []) this.handle(ev);
    this.adapter = null;
    runs.delete(this.runId);
    this.runId = null;
    if (this.live) { this.live.node.innerHTML = renderMarkdown(this.live.raw); this.live = null; }
    this.finishThinking();
    for (const card of this.tools.values()) {
      if (!card.classList.contains("ok") && !card.classList.contains("err")) card.classList.add("err");
    }
    if (code !== 0 && code != null && stderr?.trim()) this.appendError(stderr.trim());
    else if (code != null && !this.sawResult) this.appendError(t("chat.noResponse", { code }));
    else if (code == null) this.append(el("div", "meta", `⏹ ${t("chat.stopped")}`));
    this.setBusy(false);
  }
}

// The sidebar prepends a <terminal> block to prompts; show it as a chip instead.
function userBubble(text) {
  text = text.replace(/^<(yuxoterm|agentic-terminal)-context>[\s\S]*?<\/\1-context>\s*/, "");
  const m = text.match(/^<terminal[^>]*>\n?([\s\S]*?)\n?<\/terminal>\s*/);
  const bubble = el("div", "msg-user", m ? text.slice(m[0].length) : text);
  if (m) bubble.append(el("span", "ctx-chip", t("chat.contextChip", { n: m[1].split("\n").length })));
  return bubble;
}

function thinkingBlock(text, live) {
  const d = el("details", `thinking${live ? " live" : ""}`);
  d.open = live;
  d.append(el("summary", null, t("thinking.label")), el("div", "th-body", text));
  return d;
}

// ---------------------------------------------------------------------------
// Agent picker: model list + effort slider + thinking switch (per tab)
// ---------------------------------------------------------------------------
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const THINKING = ["default", "on", "off"];
// Installed agents and versions, from agents_status (refreshed at startup and in Settings).
let agentStatus = [];

const agentSettings = (id) => config.agents?.[id] ?? {};
const isInstalled = (id) => id === "custom" ? !!agentSettings("custom").command?.trim() : !!agentStatus.find((s) => s.id === id)?.installed;
const modelName = (agent, v) => (v ? agentInfo(agent).models.find((m) => m.value === canonModel(agent, v))?.name ?? v : t("agent.default"));
const effortName = (v) => t(`effort.${v || "default"}`);
const currentAgent = () => activeTab?.chat.agent;
function agentDefaults(id = config.agent || "claude") {
  const s = agentSettings(id);
  const info = agentInfo(id);
  const model = canonModel(id, s.model) || info.defaultModel || "";
  return {
    agent: id,
    model,
    effort: pickEffort(id, model, s.effort),
    thinking: s.thinking || "default",
  };
}

// Claude's model list comes from the CLI itself; the built-in list stays if it can't be read.
async function loadClaudeModels() {
  const list = await invoke("claude_models").catch(() => null);
  if (!setClaudeModels(list)) return;
  for (const tab of tabs) {
    if (!tab.chat.agentCustom) tab.chat.agent = agentDefaults();
  }
}

async function refreshAgentStatus() {
  const [status] = await Promise.all([invoke("agents_status").catch(() => agentStatus), loadClaudeModels()]);
  agentStatus = status;
  updateAgentButton();
  return agentStatus;
}

function modelOptions(agent, current) {
  const info = agentInfo(agent);
  const list = info.models.map((m) => ({ ...m, desc: m.desc ?? t(m.descKey) }));
  if (!info.defaultModel) list.unshift({ value: "", name: t("agent.default"), desc: t("agent.defaultDescOf", { agent: info.name }) });
  for (const v of [agentSettings(agent).model, current]) {
    if (v && !list.some((m) => m.value === v)) list.push({ value: v, name: v, desc: t("agent.custom") });
  }
  return list;
}

function updateAgentButton() {
  const a = currentAgent();
  if (!a) return;
  const info = agentInfo(a.agent);
  const parts = [info.short];
  if (a.model) parts.push(modelName(a.agent, a.model));
  if (a.effort && effortsFor(a.agent, a.model).length) parts.push(effortName(a.effort));
  if (a.thinking === "on" && info.thinking) parts.push(t("agent.thinking"));
  $("#agent-label").textContent = parts.join(" · ");
  $("#sb-agent-name").textContent = info.short;
  $("#prompt").placeholder = t("composer.placeholder", { agent: info.short });
  if (!$("#agent-menu").classList.contains("hidden")) renderAgentMenu();
}

function setAgent(patch) {
  const chat = activeTab?.chat;
  if (!chat) return;
  // Each agent keeps its own sessions: switching starts a new conversation.
  if (patch.agent && patch.agent !== chat.agent.agent) {
    patch = { ...agentDefaults(patch.agent), ...patch };
    if (chat.sessionId) {
      chat.sessionId = null;
      chat.sessionCwd = null;
      chat.append(el("div", "meta", t("chat.switched", { agent: agentInfo(patch.agent).name })));
    } else if ($(".chat-empty", chat.log)) {
      chat.agent.agent = patch.agent;
      chat.renderEmpty();
    }
  }
  Object.assign(chat.agent, patch);
  // A model change can drop the chosen effort level (not every model has every level).
  chat.agent.effort = pickEffort(chat.agent.agent, chat.agent.model, chat.agent.effort);
  chat.agentCustom = true;
  updateAgentButton();
  if (chat.tab === activeTab) updateSidebarCwd();
}

function renderAgentMenu() {
  const a = currentAgent();
  const info = agentInfo(a.agent);
  $("#am-agents").replaceChildren(...AGENTS.map((ag) => {
    const installed = isInstalled(ag.id);
    const b = el("button", `am-agent${ag.id === a.agent ? " selected" : ""}${installed ? "" : " missing"}`, ag.short);
    b.type = "button";
    b.title = installed ? ag.name : `${ag.name} · ${t("agents.notInstalled")}`;
    b.addEventListener("click", () => {
      if (!installed) { toast(t("agents.installHint", { agent: ag.name }), "error"); return; }
      setAgent({ agent: ag.id });
    });
    return b;
  }));

  $("#am-models").replaceChildren(...modelOptions(a.agent, a.model).map((m) => {
    const b = el("button", `am-item${m.value === a.model ? " selected" : ""}`);
    b.append(el("span", "am-name", m.name), el("span", "am-check", "✓"), el("span", "am-desc", m.desc));
    b.addEventListener("click", () => { setAgent({ model: m.value }); closeAgentMenu(); });
    return b;
  }));
  const input = $("#am-model-input");
  input.placeholder = t("agent.otherModel");
  input.value = "";

  const levels = effortsFor(a.agent, a.model);
  $("#am-effort-row").classList.toggle("hidden", !levels.length);
  if (levels.length) {
    const track = $("#am-effort");
    const idx = levels.indexOf(a.effort);
    track.replaceChildren(el("div", "fill"), ...levels.map((_, i) => el("span", `dot${i <= idx ? " on" : ""}`)), el("span", "knob"));
    track.classList.toggle("unset", idx < 0);
    track.setAttribute("aria-valuetext", effortName(a.effort));
    $("#am-effort-label").textContent = `(${effortName(levels.includes(a.effort) ? a.effort : "")})`;
    requestAnimationFrame(() => {
      const dots = track.querySelectorAll(".dot");
      const dot = dots[Math.max(0, idx)];
      if (!dot) return;
      const left = dot.offsetLeft + dot.offsetWidth / 2 - 9;
      $(".knob", track).style.left = `${left}px`;
      $(".fill", track).style.width = idx < 0 ? "0" : `${left + 20}px`;
    });
  }
  $("#am-thinking-row").classList.toggle("hidden", !info.thinking);
  if (info.thinking) {
    renderSeg($("#am-thinking"), THINKING.map((v) => ({ value: v, label: t(`thinking.${v}`) })), a.thinking || "default", (v) => setAgent({ thinking: v }));
  }
}

function setEffort(i) {
  const a = currentAgent();
  const levels = effortsFor(a.agent, a.model);
  const next = levels[Math.min(levels.length - 1, Math.max(0, i))];
  // Picking the current level again returns to the agent's default (when it has no named default).
  setAgent({ effort: a.effort === next && !agentInfo(a.agent).defaultEffort ? "" : next });
}

function openAgentMenu() {
  const menu = $("#agent-menu");
  const sidebar = $("#sidebar").getBoundingClientRect();
  const composer = $(".composer").getBoundingClientRect();
  menu.style.bottom = `${sidebar.bottom - composer.top + 6}px`;
  menu.classList.remove("hidden");
  $("#agent-btn").classList.add("open");
  renderAgentMenu();
  ($(".am-item.selected", menu) ?? $(".am-item", menu))?.focus();
}

function closeAgentMenu(refocus = true) {
  if ($("#agent-menu").classList.contains("hidden")) return;
  $("#agent-menu").classList.add("hidden");
  $("#agent-btn").classList.remove("open");
  if (refocus) $("#prompt").focus();
}

function setupAgentMenu() {
  $("#agent-btn").addEventListener("click", () => {
    if ($("#agent-menu").classList.contains("hidden")) openAgentMenu();
    else closeAgentMenu();
  });
  document.addEventListener("mousedown", (e) => {
    if (!e.target.closest("#agent-menu, #agent-btn")) closeAgentMenu(false);
  });
  const menu = $("#agent-menu");
  menu.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); closeAgentMenu(); return; }
    if (e.target.id === "am-model-input") return;
    const items = [...menu.querySelectorAll(".am-agent, .am-item, #am-model-input, #am-effort, #am-thinking button")].filter((x) => x.offsetParent);
    const i = items.indexOf(document.activeElement);
    if (e.key === "ArrowDown") { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
    if (e.key === "ArrowUp") { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
  });
  $("#am-model-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.value.trim()) { e.preventDefault(); setAgent({ model: e.target.value.trim() }); closeAgentMenu(); }
    if (e.key === "Escape") { e.preventDefault(); closeAgentMenu(); }
  });
  const track = $("#am-effort");
  track.addEventListener("click", (e) => {
    const dots = [...track.querySelectorAll(".dot")];
    let best = 0, bestDist = Infinity;
    dots.forEach((d, i) => {
      const r = d.getBoundingClientRect();
      const dist = Math.abs(e.clientX - (r.left + r.width / 2));
      if (dist < bestDist) { best = i; bestDist = dist; }
    });
    setEffort(best);
  });
  track.addEventListener("keydown", (e) => {
    const levels = effortsFor(currentAgent().agent, currentAgent().model);
    const idx = levels.indexOf(currentAgent().effort);
    if (e.key === "ArrowRight") { e.preventDefault(); setAgent({ effort: levels[Math.min(levels.length - 1, idx + 1)] }); }
    if (e.key === "ArrowLeft") { e.preventDefault(); setAgent({ effort: idx <= 0 && !agentInfo(currentAgent().agent).defaultEffort ? "" : levels[Math.max(0, idx - 1)] }); }
  });
}

// Segmented control: options [{value, label, cls?}], calls onChange(value).
function renderSeg(host, options, current, onChange) {
  host.replaceChildren(...options.map((o) => {
    const b = el("button", `${o.cls ?? ""}${o.value === current ? " active" : ""}`.trim(), o.label);
    b.type = "button";
    b.setAttribute("aria-pressed", String(o.value === current));
    b.addEventListener("click", () => {
      for (const x of host.children) { x.classList.toggle("active", x === b); x.setAttribute("aria-pressed", String(x === b)); }
      onChange(o.value);
    });
    return b;
  }));
}

function setStatus(text) {
  $("#status-text").textContent = text;
}

function toolSubject(name, input = {}) {
  switch (name) {
    case "Bash": return input.command;
    case "Read": case "Write": case "Edit": case "MultiEdit": return input.file_path;
    case "NotebookEdit": return input.notebook_path;
    case "Glob": return input.pattern;
    case "Grep": return `${input.pattern}${input.path ? "  " + input.path : ""}`;
    case "WebFetch": return input.url;
    case "WebSearch": return input.query;
    case "Task": case "Agent": return input.description;
    case "TodoWrite": return `${input.todos?.length ?? 0} todo`;
    default: return input.command ?? input.file_path ?? input.filePath ?? input.absolute_path ?? input.path ?? input.url ?? input.query ?? JSON.stringify(input);
  }
}

// "mcp__server__tool" → "tool"; the full name stays in the card's tooltip.
// Terminal tool names vary by agent (mcp__yuxoterm__run_command,
// yuxoterm_run_command, …); show just the tool.
const toolLabel = (name = "") => {
  if (name.startsWith("mcp__")) return name.split("__").pop();
  const m = name.match(/^(?:mcp_)?(?:yuxoterm|agentic_terminal)_+(.+)$/);
  return m ? m[1] : name;
};

function toolCard(block) {
  const d = el("details", "tool");
  const sum = el("summary");
  sum.append(el("span", "t-state"), el("span", "t-name", toolLabel(block.name)), el("span", "t-sub", toolSubject(block.name, block.input) ?? ""));
  sum.title = block.name;
  d.append(sum);
  let body;
  if (block.name === "Bash") body = block.input?.command;
  else if (block.name === "TodoWrite") body = (block.input?.todos ?? []).map((todo) => `${todo.status === "completed" ? "☑" : todo.status === "in_progress" ? "◐" : "☐"} ${todo.content}`).join("\n");
  else if (block.name === "Edit") body = `--- ${block.input?.file_path}\n- ${block.input?.old_string ?? ""}\n+ ${block.input?.new_string ?? ""}`;
  else body = JSON.stringify(block.input, null, 2);
  d.append(el("div", "t-label", t("tool.input")), el("pre", null, body ?? ""));
  return d;
}

function toolResultText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
  return content == null ? "" : JSON.stringify(content, null, 2);
}

// Minimal, safe markdown: escapes HTML first, then applies a small set of rules.
function renderMarkdown(src) {
  const parts = src.split(/^```/m);
  let html = "";
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      const nl = part.indexOf("\n");
      const lang = nl >= 0 ? part.slice(0, nl).trim() : part.trim();
      const code = nl >= 0 ? part.slice(nl + 1).replace(/\n$/, "") : "";
      const shell = /^(bash|sh|zsh|shell|console|)$/.test(lang);
      html += `<div class="code"><div class="code-head"><span>${esc(lang || "code")}</span>` +
        `<button data-act="copy">${esc(t("code.copy"))}</button>` +
        (shell ? `<button data-act="term" title="${esc(t("code.toTerminalTip"))}">→ ${esc(t("code.toTerminal"))}</button>` : "") +
        `</div><pre><code>${esc(code)}</code></pre></div>`;
    } else {
      html += renderBlocks(part);
    }
  });
  return html;
}

function renderInline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2">$2</a>');
}

function renderBlocks(text) {
  const lines = text.split("\n");
  let out = "", list = null, para = [];
  const flushPara = () => { if (para.length) { out += `<p>${para.map(renderInline).join("<br>")}</p>`; para = []; } };
  const flushList = () => { if (list) { out += `<${list.tag}>${list.items.map((i) => `<li>${renderInline(i)}</li>`).join("")}</${list.tag}>`; list = null; } };
  for (const line of lines) {
    let m;
    if (!line.trim()) { flushPara(); flushList(); continue; }
    if ((m = line.match(/^(#{1,4})\s+(.*)/))) { flushPara(); flushList(); out += `<h${m[1].length + 1}>${renderInline(m[2])}</h${m[1].length + 1}>`; continue; }
    if ((m = line.match(/^\s*[-*]\s+(.*)/)) || (m = line.match(/^\s*\d+[.)]\s+(.*)/))) {
      flushPara();
      const tag = /^\s*\d/.test(line) ? "ol" : "ul";
      if (list && list.tag !== tag) flushList();
      list ??= { tag, items: [] };
      list.items.push(m[1]);
      continue;
    }
    if ((m = line.match(/^>\s?(.*)/))) { flushPara(); flushList(); out += `<blockquote>${renderInline(m[1])}</blockquote>`; continue; }
    flushList();
    para.push(line);
  }
  flushPara(); flushList();
  return out;
}

function updateSidebarCwd() {
  const chat = activeTab?.chat;
  const cwd = (chat?.sessionId && chat.sessionCwd) || activeTab?.activePane?.cwd;
  $("#sb-cwd").textContent = cwd ? `‎${cwd}` : "~";
}

// Sidebar interactions
function setupSidebar() {
  const prompt = $("#prompt");
  const submit = () => {
    const chat = activeTab?.chat;
    if (!chat) return;
    if (chat.busy) { chat.cancel(); return; }
    const text = prompt.value;
    if (!text.trim()) return;
    prompt.value = "";
    autoGrow();
    chat.send(text);
  };
  const autoGrow = () => {
    prompt.style.height = "auto";
    prompt.style.height = Math.min(240, prompt.scrollHeight + 2) + "px";
  };
  prompt.addEventListener("input", autoGrow);
  prompt.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
    if (e.key === "Escape") { e.preventDefault(); activeTab?.activePane?.term.focus(); }
  });
  $("#send").addEventListener("click", submit);
  $("#new-chat").addEventListener("click", () => { activeTab?.chat.reset(); prompt.focus(); });
  $("#toggle-ai").addEventListener("click", () => toggleSidebar());


  $("#chat-host").addEventListener("click", (e) => {
    const a = e.target.closest("a[href]");
    if (a) { e.preventDefault(); invoke("open_url", { url: a.getAttribute("href") }); return; }
    const btn = e.target.closest(".code-head button");
    if (!btn) return;
    const code = btn.closest(".code").querySelector("code").textContent;
    if (btn.dataset.act === "copy") {
      navigator.clipboard.writeText(code);
      btn.textContent = t("code.copied");
      setTimeout(() => (btn.textContent = t("code.copy")), 1200);
    } else if (btn.dataset.act === "term") {
      const pane = activeTab?.activePane;
      if (pane?.alive) {
        pane.term.paste(code);
        pane.term.focus();
      }
    }
  });

  // Resizable sidebar width
  const root = document.documentElement;
  root.style.setProperty("--sidebar-w", `${store.get("sidebarWidth", 400)}px`);
  $("#sidebar-resizer").addEventListener("mousedown", (e) => {
    e.preventDefault();
    document.body.classList.add("resizing-col");
    const move = (ev) => {
      const w = Math.min(window.innerWidth * 0.7, Math.max(280, window.innerWidth - ev.clientX));
      root.style.setProperty("--sidebar-w", `${w}px`);
      store.set("sidebarWidth", Math.round(w));
    };
    const up = () => {
      document.body.classList.remove("resizing-col");
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  });
  setSidebar(store.get("sidebarOpen", true));
}

function setSidebar(open) {
  document.body.classList.toggle("sidebar-closed", !open);
  $("#toggle-ai").classList.toggle("on", open);
  store.set("sidebarOpen", open);
  requestAnimationFrame(() => activeTab?.panes.forEach((p) => p.doFit()));
}

function toggleSidebar(force) {
  const open = force ?? document.body.classList.contains("sidebar-closed");
  setSidebar(open);
  if (open) $("#prompt").focus();
  else activeTab?.activePane?.term.focus();
}

// ---------------------------------------------------------------------------
// Agent terminal tools: Claude drives the user's real panes through the
// yuxoterm MCP server (src-tauri/src/mcp.rs → socket → here).
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Foreground programs that sit waiting for input when they go quiet.
const INTERACTIVE = /^(ssh|docker|kubectl|mysql|mariadb|psql|sqlite3|redis-cli|mongo|mongosh|python\d*(\.\d+)?|ipython|node|deno|bun|irb|php|psysh|tinker|bash|sh|zsh|fish|dash|ash|less|more|man|vim?|nvim|nano|top|htop|btop|tmux|screen|ftp|sftp|telnet|nc|claude)$/;
const KEYS = {
  enter: "\r", return: "\r", tab: "\t", esc: "\x1b", escape: "\x1b", space: " ", backspace: "\x7f",
  up: "\x1b[A", down: "\x1b[B", right: "\x1b[C", left: "\x1b[D", home: "\x1b[H", end: "\x1b[F",
  pageup: "\x1b[5~", pagedown: "\x1b[6~", delete: "\x1b[3~",
};

function keySeq(name) {
  const ctrl = name.match(/^(?:C-|Ctrl[-+]|\^)(.)$/i);
  if (ctrl) return String.fromCharCode(ctrl[1].toUpperCase().charCodeAt(0) & 0x1f);
  const seq = KEYS[name.toLowerCase()];
  if (seq == null) throw new Error(`Unknown key: ${name}`);
  return seq;
}

// Plain text of buffer lines [from, to), joining soft-wrapped rows.
function bufferText(pane, from, to) {
  const buf = pane.term.buffer.active;
  const out = [];
  for (let i = Math.max(0, from); i < Math.min(to, buf.length); i++) {
    const line = buf.getLine(i);
    if (!line) continue;
    const text = line.translateToString(true);
    if (line.isWrapped && out.length) out[out.length - 1] += text;
    else out.push(text);
  }
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out.join("\n");
}

function screenTail(pane, lines) {
  const buf = pane.term.buffer.active;
  return bufferText(pane, buf.length - lines, buf.length);
}

function clip(text, maxLines = 300, maxChars = 20000) {
  let lines = text.split("\n");
  let note = "";
  if (lines.length > maxLines) { note = `… (${lines.length - maxLines} earlier lines omitted)\n`; lines = lines.slice(-maxLines); }
  let out = lines.join("\n");
  if (out.length > maxChars) { note = "… (earlier output omitted)\n"; out = out.slice(-maxChars); }
  return note + out;
}

function agentMark(pane) {
  pane.el.classList.add("agent");
  clearTimeout(pane.agentTimer);
  pane.agentTimer = setTimeout(() => pane.el.classList.remove("agent"), 1500);
}

// Waits until the command finishes, an interactive program is waiting for
// input, or the timeout hits. Returns a short status for Claude.
async function waitForCommand(pane, idleMs, timeoutMs) {
  const start = performance.now();
  pane.lastOutput = start;
  let fg = null;
  while (true) {
    await sleep(150);
    agentMark(pane);
    if (!pane.alive) return { done: true, status: "pane closed (shell exited)" };
    const now = performance.now();
    const quiet = now - pane.lastOutput;
    if (quiet >= Math.min(idleMs, 400) && now - start >= 300) {
      fg = await invoke("pty_foreground", { id: pane.id }).catch(() => null);
      if (fg?.shell_idle && quiet >= 300) return { done: true, status: "finished; shell is back at its prompt" };
      if (quiet >= idleMs && fg && INTERACTIVE.test(fg.name)) {
        return { done: true, status: `${fg.name} is running and waiting for input (interactive session)` };
      }
      if (quiet >= idleMs && !fg) return { done: true, status: "output stopped" };
    }
    if (now - start >= timeoutMs) {
      return { done: false, status: `still running${fg?.name ? ` (${fg.name})` : ""} after ${Math.round(timeoutMs / 1000)}s; use read_screen to check on it or send_keys C-c to stop it` };
    }
  }
}

function resolvePane(tab, paneId, { write = false } = {}) {
  const pane = paneId ? panes.get(paneId) : tab.activePane;
  if (!pane) throw new Error(`Pane ${paneId} not found. Call list_panes to see open panes.`);
  if (!pane.alive) throw new Error(`Pane ${pane.id} is no longer running.`);
  if (write && pane.readOnly) throw new Error(`Pane ${pane.id} is read-only: the user locked it against input. Use another pane or ask the user.`);
  return pane;
}

const agentTools = {
  async list_panes(tab) {
    const out = [];
    for (const other of tabs) {
      for (const p of other.panes) {
        const fg = await invoke("pty_foreground", { id: p.id }).catch(() => null);
        out.push({
          pane_id: p.id,
          tab_id: other.id,
          tab_title: $(".tab-title", other.header).textContent,
          cwd: p.cwd,
          running: fg ? (fg.shell_idle ? "shell (idle)" : fg.name) : null,
          is_default: other === tab && p === other.activePane,
          in_your_tab: other === tab,
        });
      }
    }
    return out;
  },

  async run_command(tab, { command, pane_id, timeout_ms = 30000, idle_ms = 1500 }) {
    if (!command?.trim()) throw new Error("command is empty");
    const pane = resolvePane(tab, pane_id, { write: true });
    const buf = pane.term.buffer.active;
    const from = buf.baseY + buf.cursorY;
    agentMark(pane);
    await invoke("pty_write", { id: pane.id, data: command.replace(/\r?\n$/, "") + "\r" });
    const res = await waitForCommand(pane, Math.max(300, idle_ms), Math.min(600000, Math.max(1000, timeout_ms)));
    const alt = pane.term.buffer.active.type === "alternate";
    const output = alt ? screenTail(pane, pane.term.rows) : bufferText(pane, from, pane.term.buffer.active.length);
    return `[pane ${pane.id} · ${res.status}]${alt ? " (full-screen program)" : ""}\n${clip(output)}`;
  },

  async send_keys(tab, { text = "", keys = [], pane_id, wait_ms = 800 }) {
    const pane = resolvePane(tab, pane_id, { write: true });
    const data = text.replace(/\r?\n/g, "\r") + keys.map(keySeq).join("");
    if (!data) throw new Error("provide text or keys");
    agentMark(pane);
    await invoke("pty_write", { id: pane.id, data });
    await sleep(Math.min(10000, Math.max(100, wait_ms)));
    const res = await waitForCommand(pane, 500, 4000);
    return `[pane ${pane.id} · ${res.status}]\n${clip(screenTail(pane, 60))}`;
  },

  async read_screen(tab, { pane_id, lines = 60 }) {
    const pane = resolvePane(tab, pane_id);
    const fg = await invoke("pty_foreground", { id: pane.id }).catch(() => null);
    const running = fg ? (fg.shell_idle ? "shell idle" : `running ${fg.name}`) : "status unknown";
    return `[pane ${pane.id} · ${running}]\n${clip(screenTail(pane, Math.min(2000, Math.max(1, lines))), 2000, 60000)}`;
  },

  async open_pane(tab, { direction = "right", cwd, command }) {
    if (direction === "tab") {
      const created = await newTab(cwd || tab.activePane?.cwd, command, { activate: false, profile: LOCAL });
      return `Opened tab ${created.id} with pane ${created.activePane.id} in the background.`;
    }
    const base = tab.activePane;
    const pane = await tab.split(base, direction === "down" ? "col" : "row", command, { cwd, focus: false, profile: LOCAL });
    if (command) await waitForCommand(pane, 1200, 8000);
    agentMark(pane);
    return `Opened pane ${pane.id} (${direction}).${command ? `\n${clip(screenTail(pane, 30))}` : ""}`;
  },
};

async function runAgentTool({ id, tab: tabId, name, args }) {
  const tab = tabs.find((x) => x.id === tabId) ?? activeTab;
  try {
    const fn = agentTools[name];
    if (!fn) throw new Error(`Unknown tool: ${name}`);
    const result = await fn(tab, args ?? {});
    await invoke("agent_tool_result", { id, result: { result: typeof result === "string" ? result : JSON.stringify(result, null, 2) } });
  } catch (e) {
    await invoke("agent_tool_result", { id, result: { error: String(e?.message ?? e) } });
  }
}

// ---------------------------------------------------------------------------
// Chat history (Claude Code transcripts)
// ---------------------------------------------------------------------------
let historyScope = "cwd";
let historyTimer = 0;

function setupHistory() {
  $("#history-btn").addEventListener("click", () => toggleHistory());
  $("#history-close").addEventListener("click", () => toggleHistory(false));
  $("#history-search").addEventListener("input", () => {
    clearTimeout(historyTimer);
    historyTimer = setTimeout(refreshHistory, 150);
  });
  $("#history-search").addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); toggleHistory(false); }
    if (e.key === "ArrowDown") { e.preventDefault(); $("#history-list .h-item")?.focus(); }
  });
  $("#history-app-only").addEventListener("change", refreshHistory);
  for (const chip of document.querySelectorAll(".hp-filters [data-scope]")) {
    chip.addEventListener("click", () => {
      historyScope = chip.dataset.scope;
      for (const c of document.querySelectorAll(".hp-filters [data-scope]")) c.classList.toggle("active", c === chip);
      refreshHistory();
    });
  }
  $("#history-list").addEventListener("keydown", (e) => {
    const item = e.target.closest(".h-item");
    if (!item) return;
    const items = [...document.querySelectorAll("#history-list .h-item")];
    if (e.key === "Delete" || (e.key === "Backspace" && e.metaKey)) { e.preventDefault(); item.nextElementSibling?.click(); return; }
    const i = items.indexOf(item);
    if (e.key === "ArrowDown") { e.preventDefault(); items[i + 1]?.focus(); }
    if (e.key === "ArrowUp") { e.preventDefault(); (items[i - 1] ?? $("#history-search")).focus(); }
    if (e.key === "Escape") { e.preventDefault(); toggleHistory(false); }
  });
}

function toggleHistory(force) {
  const panel = $("#history-panel");
  const open = force ?? panel.classList.contains("hidden");
  if (open) setSidebar(true);
  panel.classList.toggle("hidden", !open);
  $("#history-btn").classList.toggle("active", open);
  if (open) {
    refreshHistory();
    $("#history-search").focus();
  } else {
    $("#prompt").focus();
  }
}

let historySeq = 0;
async function refreshHistory() {
  // Only the latest request may render; older ones would wipe newer state.
  const seq = ++historySeq;
  const list = $("#history-list");
  const cwd = historyScope === "cwd" ? ((await invoke("pty_cwd", { id: activeTab.activePane.id }).catch(() => null)) || activeTab.activePane.cwd) : null;
  const sessions = await invoke("history_list", {
    cwd, appOnly: $("#history-app-only").checked, query: $("#history-search").value.trim() || null,
  }).catch(() => []);
  if (seq !== historySeq) return;
  list.replaceChildren();
  if (!sessions.length) {
    list.append(el("div", "h-empty", historyScope === "cwd" && cwd ? t("history.emptyFolder", { folder: basename(cwd) }) : t("history.empty")));
    return;
  }
  let group = null;
  for (const s of sessions) {
    const g = dayGroup(s.updated);
    if (g !== group) { list.append(el("div", "h-group", g)); group = g; }
    const item = el("button", "h-item");
    item.classList.toggle("current", s.id === activeTab.chat.sessionId);
    item.append(el("span", "h-title", s.title));
    const meta = el("span", "h-meta");
    meta.append(el("span", null, timeAgo(s.updated)), el("span", null, `· ${s.messages === 1 ? t("history.message") : t("history.messages", { n: s.messages })}`));
    if (historyScope === "all") meta.append(el("span", "h-cwd", `· ${s.cwd.replace(/^\/Users\/[^/]+/, "~")}`));
    meta.append(el("span", "h-agent", agentInfo(s.agent).short));
    if (s.from_app) meta.append(el("span", "h-app", "✦"));
    item.append(meta);
    item.title = `${s.title}\n${s.cwd}`;
    item.addEventListener("click", () => openSession(s.id));
    const row = el("div", "h-row");
    row.append(item, deleteButton(s, row));
    list.append(row);
  }
}

// Two-step delete: first click arms the button, second click moves the session to the Trash.
function deleteButton(session, row) {
  const btn = el("button", "h-del", "🗑");
  btn.title = t("history.delete");
  btn.setAttribute("aria-label", t("history.delete"));
  let timer = 0;
  const disarm = () => { btn.classList.remove("confirm"); btn.textContent = "🗑"; };
  btn.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!btn.classList.contains("confirm")) {
      btn.classList.add("confirm");
      btn.textContent = t("history.confirmDelete");
      clearTimeout(timer);
      timer = setTimeout(disarm, 3000);
      return;
    }
    clearTimeout(timer);
    try {
      await invoke("history_delete", { id: session.id });
    } catch (err) {
      toast(String(err), "error");
      disarm();
      return;
    }
    for (const tab of tabs) {
      if (tab.chat.sessionId === session.id && !tab.chat.busy) {
        tab.chat.sessionId = null;
        tab.chat.sessionCwd = null;
        tab.chat.append(el("div", "meta", t("chat.deleted")));
      }
    }
    const group = row.previousElementSibling;
    row.remove();
    // Drop a day header left with no sessions under it.
    if (group?.classList.contains("h-group") && (!group.nextElementSibling || group.nextElementSibling.classList.contains("h-group"))) group.remove();
    if (!$("#history-list .h-row")) refreshHistory();
  });
  btn.addEventListener("blur", () => { clearTimeout(timer); disarm(); });
  return btn;
}

async function openSession(id) {
  const chat = activeTab.chat;
  if (chat.busy) { toast(t("history.busy"), "error"); return; }
  try {
    const session = await invoke("history_load", { id });
    // Keep the current conversation: open the old one in a new tab if this one is in use.
    const target = chat.sessionId && chat.sessionId !== id ? (await newTab(session.cwd || null, undefined, { profile: LOCAL })).chat : chat;
    target.loadSession(session);
    toggleHistory(false);
  } catch (e) {
    toast(String(e), "error");
  }
}

function dayGroup(ms) {
  const d = new Date(ms), now = new Date();
  const days = Math.floor((new Date(now.toDateString()) - new Date(d.toDateString())) / 86400000);
  if (days === 0) return t("time.today");
  if (days === 1) return t("time.yesterday");
  if (days < 7) return t("time.week");
  if (days < 30) return t("time.month");
  return d.toLocaleDateString(locale(), { month: "long", year: "numeric" });
}

function timeAgo(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return t("time.now");
  if (s < 3600) return t("time.min", { n: Math.floor(s / 60) });
  if (s < 86400) return t("time.hour", { n: Math.floor(s / 3600) });
  return new Date(ms).toLocaleDateString(locale(), { day: "numeric", month: "short" });
}

// ---------------------------------------------------------------------------
// Toasts and confirm dialog (in-app replacements for alert/confirm)
// ---------------------------------------------------------------------------
function toast(message, kind = "info", ms = 4000) {
  const n = el("div", `toast ${kind}`, message);
  $("#toasts").append(n);
  setTimeout(() => n.remove(), ms);
}

let confirmResolve = null;
function confirmDialog({ title, body, ok = t("dialog.confirm"), danger = false }) {
  $("#confirm-title").textContent = title;
  $("#confirm-body").textContent = body;
  const okBtn = $("#confirm-ok");
  okBtn.textContent = ok;
  okBtn.className = danger ? "danger-btn" : "primary-btn";
  $("#confirm").classList.remove("hidden");
  okBtn.focus();
  return new Promise((resolve) => { confirmResolve = resolve; });
}

function closeConfirm(result) {
  $("#confirm").classList.add("hidden");
  confirmResolve?.(result);
  confirmResolve = null;
}

function setupConfirm() {
  $("#confirm-ok").addEventListener("click", () => closeConfirm(true));
  $("#confirm-cancel").addEventListener("click", () => closeConfirm(false));
}

// ---------------------------------------------------------------------------
// Guard approval dialog
// ---------------------------------------------------------------------------
const askQueue = [];

function showNextAsk() {
  const modal = $("#guard-ask");
  const req = askQueue[0];
  if (!req) { modal.classList.add("hidden"); activeTab?.activePane?.term.focus(); return; }
  const tab = tabs.find((x) => x.chat.sessionId && x.chat.sessionId === req.session_id);
  const rule = req.rule ? ruleName(req.rule) : t("ask.defaultRule");
  $("#ask-meta").innerHTML = t("ask.body", { tool: esc(toolLabel(req.tool)), rule: esc(rule) });
  $("#ask-subject").textContent = req.subject;
  const details = $("#ask-details");
  details.replaceChildren();
  if (req.cwd) details.append(el("span", null, t("ask.folder")), el("span", null, req.cwd));
  if (tab) details.append(el("span", null, t("ask.tab")), el("span", null, $(".tab-title", tab.header).textContent));
  updateAskQueue();
  modal.classList.remove("hidden");
  $("#ask-allow").focus();
}

function updateAskQueue() {
  $("#ask-queue").textContent = askQueue.length > 1 ? t("ask.more", { n: askQueue.length - 1 }) : "";
}

function answerAsk(allow) {
  const req = askQueue.shift();
  if (req) invoke("guard_respond", { id: req.id, allow });
  showNextAsk();
}

function setupGuardAsk() {
  $("#ask-allow").addEventListener("click", () => answerAsk(true));
  $("#ask-deny").addEventListener("click", () => answerAsk(false));
  listen("guard-ask", (e) => {
    askQueue.push(e.payload);
    if (askQueue.length === 1) showNextAsk();
    else updateAskQueue();
    appWindow.setFocus().catch(() => {});
    appWindow.requestUserAttention(1).catch(() => {});
  });
  listen("guard-ask-closed", (e) => {
    const i = askQueue.findIndex((r) => r.id === e.payload);
    if (i < 0) return;
    askQueue.splice(i, 1);
    if (i === 0) showNextAsk();
    else updateAskQueue();
  });
}

// ---------------------------------------------------------------------------
// Settings: every change is saved automatically
// ---------------------------------------------------------------------------
const DEFAULT_FONT = '"MesloLGS NF", "JetBrainsMono Nerd Font", "Symbols Nerd Font Mono", "JetBrains Mono", "SF Mono", Menlo, monospace';
const PERMISSION_MODES = ["bypassPermissions", "acceptEdits", "auto", "dontAsk", "plan"];
const GUARD_ACTIONS = ["allow", "ask", "deny"];
// [group, [[label key, [part lists…]], …]]: several part lists are shown as "a / b".
const shortcutGroups = () => [
  ["keys.tabs", [
    ["keys.newTab", [shortcutParts("newTab")]], ["keys.profileMenu", [shortcutParts("profileMenu")]], ["keys.closePane", [shortcutParts("closePane")]], ["keys.closeTab", [shortcutParts("closeTab")]],
    ["keys.splitRight", [shortcutParts("splitRight")]], ["keys.splitDown", [shortcutParts("splitDown")]],
    ["keys.prevNextPane", [shortcutParts("prevPane"), shortcutParts("nextPane")]],
    ["keys.paneDirection", [shortcutRange("paneLeft", "← ↑ → ↓")]],
    ["keys.prevNextTab", [shortcutParts("prevTab"), shortcutParts("nextTab")]],
    ["keys.goToTab", [shortcutRange("tab1", "1…9")]],
  ]],
  ["keys.agent", [
    ["keys.toggleSidebar", [shortcutParts("sidebar")]], ["keys.focusPrompt", [shortcutParts("focusPrompt")]], ["keys.history", [shortcutParts("history")]],
    ["keys.send", [shortcutParts("send")]], ["keys.newline", [shortcutParts("newline")]], ["keys.allow", [shortcutParts("allow")]],
  ]],
  ["keys.view", [
    ["keys.copy", [IS_MAC ? ["⌘", "C"] : shortcutParts("copy")]], ["keys.paste", [IS_MAC ? ["⌘", "V"] : shortcutParts("paste")]],
    ["keys.clear", [shortcutParts("clear")]],
    ["keys.fontSize", [shortcutParts("fontUp"), shortcutParts("fontDown"), shortcutParts("fontReset")]],
    ["keys.settings", [shortcutParts("settings")]],
  ]],
];

let guardDraft = null;
let configSaveTimer = 0;
let guardSaveTimer = 0;
let currentSection = "general";

function flashSaved() {
  const badge = $("#settings-saved");
  badge.classList.add("show");
  clearTimeout(flashSaved.timer);
  flashSaved.timer = setTimeout(() => badge.classList.remove("show"), 1400);
}

function updateConfig(patch) {
  Object.assign(config, patch);
  clearTimeout(configSaveTimer);
  configSaveTimer = setTimeout(async () => {
    try {
      await invoke("save_config", { config });
      flashSaved();
    } catch (e) {
      toast(t("toast.saveFailed", { error: String(e) }), "error");
    }
  }, 350);
}

const isOn = (sw) => sw.getAttribute("aria-checked") === "true";
const setSwitch = (sw, on) => sw.setAttribute("aria-checked", String(!!on));
function onSwitch(sw, fn) {
  sw.addEventListener("click", () => {
    setSwitch(sw, !isOn(sw));
    fn(isOn(sw));
  });
}

// Debounced text input → callback with the current value.
function onText(input, fn, wait = 400) {
  let timer = 0;
  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(input.value), wait);
  });
}

// Connects each row's visible label to its control for screen readers.
function labelRows(root) {
  let n = 0;
  for (const row of root.querySelectorAll(".s-row")) {
    const label = row.querySelector(".s-label > div:first-child");
    const control = row.querySelector("input, select, textarea, .switch, .seg");
    if (!label || !control) continue;
    label.id ||= `s-label-${++n}`;
    control.setAttribute("aria-labelledby", label.id);
  }
}

function setupSettings() {
  for (const b of document.querySelectorAll(".settings-nav [data-section]")) {
    b.addEventListener("click", () => showSection(b.dataset.section));
  }
  $("#open-settings").addEventListener("click", () => openSettings());
  $("#settings-close").addEventListener("click", closeSettings);
  $("#settings").addEventListener("mousedown", (e) => { if (e.target.id === "settings") closeSettings(); });
  labelRows($("#settings"));

  // General
  $("#set-language").addEventListener("change", (e) => { updateConfig({ language: e.target.value }); applyLanguage(); });
  onText($("#set-font-family"), (v) => { updateConfig({ font_family: v.trim() || DEFAULT_FONT }); applyFont(); }, 600);
  const fontSize = $("#set-font-size");
  const setFontSize = (v) => {
    const size = Math.min(32, Math.max(8, Math.round(Number(v) || 13)));
    fontSize.value = size;
    updateConfig({ font_size: size });
    applyFont();
  };
  fontSize.addEventListener("change", () => setFontSize(fontSize.value));
  for (const b of document.querySelectorAll(".stepper [data-step]")) {
    b.addEventListener("click", () => setFontSize(Number(fontSize.value) + Number(b.dataset.step)));
  }

  // Agents
  $("#agents-refresh").addEventListener("click", () => { renderAgentList(true); refreshAgentStatus().then(() => { renderAgentList(); renderDefaults(); }); });
  $("#set-permission").addEventListener("change", (e) => { updateConfig({ permission_mode: e.target.value }); renderPermissionNote(); });
  onSwitch($("#set-include-ctx"), (on) => { updateConfig({ include_terminal_context: on }); $("#ctx-toggle").checked = on; });
  $("#set-ctx-lines").addEventListener("change", (e) => {
    const n = Math.min(2000, Math.max(10, Number(e.target.value) || 80));
    e.target.value = n;
    updateConfig({ context_lines: n });
    updateContextTip();
  });
  onText($("#set-instructions"), (v) => updateConfig({ append_system_prompt: v }), 600);

  // New chat defaults
  onText($("#def-custom-model"), (v) => setDefault({ model: v.trim() }, { keepCustomInput: true }));
  $("#def-budget").addEventListener("change", (e) => {
    const n = Math.max(0, Math.round(Number(e.target.value) || 0));
    e.target.value = n || "";
    updateConfig({ thinking_budget: n });
  });
  $("#def-apply").addEventListener("click", () => {
    for (const tab of tabs) { tab.chat.agent = agentDefaults(); tab.chat.agentCustom = false; }
    updateAgentButton();
    toast(t("defaults.applied", { n: tabs.length }), "ok", 2500);
  });

  // Guard
  onSwitch($("#guard-enabled"), (on) => { guardDraft.enabled = on; renderGuardEnabled(); saveGuardSoon(); });
  $("#guard-timeout").addEventListener("change", (e) => {
    const n = Math.min(3600, Math.max(10, Number(e.target.value) || 300));
    e.target.value = n;
    guardDraft.ask_timeout_secs = n;
    saveGuardSoon();
  });
  $("#rule-add").addEventListener("click", () => {
    readRules();
    guardDraft.rules.push({ name: t("guard.newRule"), tool: "Bash", pattern: "", action: "ask", enabled: true });
    renderRules();
    $("#rules").lastElementChild?.querySelector(".name")?.select();
  });
  $("#guard-reset").addEventListener("click", async () => {
    const ok = await confirmDialog({ title: t("guard.restoreTitle"), body: t("guard.restoreBody"), ok: t("guard.restore"), danger: true });
    if (!ok) return;
    guardDraft = await invoke("reset_guard");
    fillGuard();
    flashSaved();
  });
  $("#test-tool").addEventListener("change", runGuardTest);
  $("#test-subject").addEventListener("input", runGuardTest);
  onSwitch($("#guard-global"), async (on) => {
    try {
      setSwitch($("#guard-global"), await invoke("guard_install_global", { enable: on }));
      flashSaved();
    } catch (err) {
      setSwitch($("#guard-global"), !on);
      toast(String(err), "error");
    }
  });
}

function showSection(name) {
  currentSection = name;
  for (const b of document.querySelectorAll(".settings-nav [data-section]")) b.classList.toggle("active", b.dataset.section === name);
  for (const sec of document.querySelectorAll(".settings-body [data-panel]")) {
    const show = sec.dataset.panel === name;
    sec.classList.toggle("hidden", !show);
    if (show) $("#settings-section-title").textContent = t(sec.dataset.title);
  }
  $(".settings-body").scrollTop = 0;
}

async function openSettings(section) {
  guardDraft = await invoke("get_guard");
  fillSettings();
  showSection(section ?? currentSection);
  $("#settings").classList.remove("hidden");
  refreshAgentStatus().then(() => { renderAgentList(); renderDefaults(); });
}

// Fills every control from `config` / `guardDraft` (also used after a language change).
function fillSettings() {
  const c = config;
  const langSel = $("#set-language");
  langSel.replaceChildren(...LANGUAGES.map((l) => {
    const o = el("option", null, l.labelKey ? t(l.labelKey) : l.label);
    o.value = l.value;
    return o;
  }));
  langSel.value = c.language || "system";
  $("#set-font-family").value = c.font_family;
  $("#set-font-size").value = c.font_size;

  const permSel = $("#set-permission");
  permSel.replaceChildren(...PERMISSION_MODES.map((m) => {
    const o = el("option", null, t(`perm.${m}`));
    o.value = m;
    return o;
  }));
  permSel.value = c.permission_mode;
  renderPermissionNote();
  setSwitch($("#set-include-ctx"), c.include_terminal_context);
  $("#set-ctx-lines").value = c.context_lines;
  $("#set-instructions").value = c.append_system_prompt;

  renderAgentList();
  renderDefaults();
  if (guardDraft) fillGuard();
  invoke("guard_info").then((info) => {
    setSwitch($("#guard-global"), info.global_installed);
    $("#guard-global-desc").textContent = t("guard.globalDesc", { path: info.claude_settings_path.replace(/^\/Users\/[^/]+/, "~") });
    $("#guard-paths").textContent = `${info.guard_path}\n${info.log_path}\n${info.hook_command}`;
  });
  renderShortcuts();
  renderProfiles();
}

// Hosts and shells are read from disk each time the panel is shown, so edits to
// ~/.ssh/config appear without restarting.
async function renderProfiles() {
  const [hosts, shells] = await Promise.all([
    invoke("ssh_hosts").catch(() => []),
    invoke("shells_available").catch(() => []),
  ]);
  renderProfileSettings($("#profile-panel"), { config, hosts, shells, update: updateConfig, confirm: confirmDialog });
}

function renderPermissionNote() {
  $("#perm-desc").textContent = t(`permDesc.${config.permission_mode}`);
}

function updateContextTip() {
  $("#ctx-label").title = t("composer.contextTip", { n: config.context_lines || 80 });
}

function updateAgentConfig(id, patch) {
  const agents = { ...(config.agents ?? {}) };
  agents[id] = { ...(agents[id] ?? {}), ...patch };
  updateConfig({ agents });
}

// Changing a default updates every tab whose agent the user hasn't customized.
function setDefault(patch, { keepCustomInput = false } = {}) {
  if (patch.agent) updateConfig({ agent: patch.agent });
  else updateAgentConfig(config.agent, patch);
  for (const tab of tabs) {
    if (tab.chat.agentCustom) continue;
    const switched = tab.chat.agent.agent !== config.agent;
    tab.chat.agent = agentDefaults();
    if (switched && $(".chat-empty", tab.chat.log)) tab.chat.renderEmpty();
  }
  updateAgentButton();
  renderDefaults({ keepCustomInput });
  renderAgentList();
}

function renderDefaults({ keepCustomInput = false } = {}) {
  const id = config.agent || "claude";
  const info = agentInfo(id);
  const s = agentSettings(id);
  $("#def-agents").replaceChildren(...AGENTS.map((ag) => {
    const installed = isInstalled(ag.id);
    const b = el("button", `model-opt${ag.id === id ? " selected" : ""}${installed ? "" : " disabled"}`);
    b.type = "button";
    b.setAttribute("aria-pressed", String(ag.id === id));
    const st = agentStatus.find((x) => x.id === ag.id);
    b.append(el("span", "mo-name", ag.name), el("span", "mo-desc", installed ? (st?.version ?? t("agents.configured")) : t("agents.notInstalled")));
    b.addEventListener("click", () => {
      if (!installed) { toast(t("agents.installHint", { agent: ag.name }), "error"); return; }
      setDefault({ agent: ag.id });
    });
    return b;
  }));

  $("#def-model-title").textContent = t("defaults.modelFor", { agent: info.name });
  const curModel = canonModel(id, s.model) || info.defaultModel || "";
  const opts = modelOptions(id, s.model).filter((m) => m.value === "" || info.models.some((x) => x.value === m.value));
  $("#def-models").replaceChildren(...opts.map((m) => {
    const b = el("button", `model-opt${m.value === curModel ? " selected" : ""}`);
    b.type = "button";
    b.setAttribute("aria-pressed", String(m.value === curModel));
    b.append(el("span", "mo-name", m.name), el("span", "mo-desc", m.desc));
    b.addEventListener("click", () => { $("#def-custom-model").value = ""; setDefault({ model: m.value }); });
    return b;
  }));
  $("#def-custom-desc").textContent = info.models.length ? "" : t("defaults.customModelDesc", { agent: info.name });
  if (!keepCustomInput) $("#def-custom-model").value = info.models.some((m) => m.value === s.model) ? "" : (s.model ?? "");

  const levels = effortsFor(id, curModel);
  $("#def-effort-row").classList.toggle("hidden", !levels.length);
  renderSeg($("#def-effort"), (info.defaultEffort ? levels : ["", ...levels]).map((v) => ({ value: v, label: effortName(v) })), pickEffort(id, curModel, s.effort), (v) => setDefault({ effort: v }));
  $("#def-thinking-row").classList.toggle("hidden", !info.thinking);
  renderSeg($("#def-thinking"), THINKING.map((v) => ({ value: v, label: t(`thinking.${v}`) })), s.thinking || "default", (v) => setDefault({ thinking: v }));
  $("#def-budget-row").classList.toggle("hidden", !(id === "claude" && s.thinking === "on"));
  $("#def-budget").value = config.thinking_budget || "";
  $("#def-reasoning").classList.toggle("hidden", !levels.length && !info.thinking);
}

const KEY_ENVS = { claude: "ANTHROPIC_API_KEY", codex: "CODEX_API_KEY", antigravity: "GEMINI_API_KEY", gemini: "GEMINI_API_KEY", cursor: "CURSOR_API_KEY" };
const openAgentRows = new Set();

// One expandable row per agent: status, default, location, key, options, tools.
function renderAgentList(checking = false) {
  const host = $("#agent-list");
  host.replaceChildren(...AGENTS.map((ag) => {
    const st = agentStatus.find((x) => x.id === ag.id);
    const s = agentSettings(ag.id);
    const installed = isInstalled(ag.id);
    const isDefault = (config.agent || "claude") === ag.id;
    const row = el("div", `ag-row${installed ? " ok" : ""}${openAgentRows.has(ag.id) ? " open" : ""}`);

    const head = el("div", "ag-head");
    head.setAttribute("role", "button");
    head.tabIndex = 0;
    const main = el("div", "ag-main");
    const name = el("div", "ag-name", ag.name);
    if (isDefault) name.append(el("span", "ag-tag default", t("agents.default")));
    if (installed && st?.guard === "terminal_tools") name.append(el("span", "ag-tag", t("agents.guardPartial")));
    const sub = checking ? t("agents.checking")
      : ag.custom ? (s.command?.trim() || t("agents.customNotSet"))
      : installed ? `${st.version} · ${st.path}` : t("agents.notInstalled");
    main.append(name, el("div", "ag-sub", sub));
    head.append(el("span", "ag-dot"), main, el("span", "ag-chev", "›"));
    const toggle = () => {
      row.classList.toggle("open");
      if (row.classList.contains("open")) openAgentRows.add(ag.id); else openAgentRows.delete(ag.id);
    };
    head.addEventListener("click", toggle);
    head.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } });

    const body = el("div", "ag-body");
    const field = (labelKey, descText, control) => {
      const r = el("div", "s-row");
      const label = el("div", "s-label");
      label.append(el("div", null, t(labelKey)));
      if (descText) label.append(el("div", "s-desc", descText));
      const c = el("div", "s-control wide");
      c.append(control);
      r.append(label, c);
      body.append(r);
      return r;
    };
    const textInput = (key, placeholder, { mono = true, type = "text" } = {}) => {
      const inp = el("input", mono ? "mono" : "");
      inp.type = type;
      inp.spellcheck = false;
      inp.autocomplete = "off";
      inp.placeholder = placeholder;
      inp.value = s[key] ?? "";
      onText(inp, (v) => updateAgentConfig(ag.id, { [key]: v.trim() }));
      return inp;
    };

    if (!installed && !ag.custom && st?.install) {
      const note = el("div", "ag-note");
      note.append(t("agents.installWith"), " ", el("span", "ag-install", st.install));
      body.append(note);
    }
    if (ag.custom) {
      field("agents.command", t("agents.commandDesc"), textInput("command", "e.g. aider --yes-always --message {prompt}"));
      const fmt = el("select");
      for (const f of FORMATS) { const o = el("option", null, t(`format.${f}`)); o.value = f; fmt.append(o); }
      fmt.value = s.format || "text";
      fmt.addEventListener("change", () => updateAgentConfig(ag.id, { format: fmt.value }));
      field("agents.format", null, fmt);
    } else {
      field("agents.location", t("agents.locationDesc"), textInput("path", st?.path ?? t("agents.locationPlaceholder")));
      if (KEY_ENVS[ag.id]) field("agents.apiKey", t("agents.apiKeyDesc", { env: KEY_ENVS[ag.id] }), textInput("api_key", t("agents.apiKeyPlaceholder"), { type: "password" }));
      field("agents.extraArgs", t("agents.extraArgsDesc"), textInput("extra_args", t("agents.extraArgsPlaceholder")));
    }

    if (st?.tools_installed != null) {
      const sw = el("button", "switch");
      sw.setAttribute("role", "switch");
      setSwitch(sw, st.tools_installed);
      sw.append(el("span"));
      onSwitch(sw, async (on) => {
        try {
          st.tools_installed = await invoke("agent_tools_install", { agent: ag.id, enable: on });
          setSwitch(sw, st.tools_installed);
          flashSaved();
        } catch (e) { setSwitch(sw, !on); toast(String(e), "error"); }
      });
      const r = field("agents.tools", t("agents.toolsDesc", { agent: ag.name }), sw);
      r.querySelector(".s-control").classList.remove("wide");
    }
    if (!ag.custom) {
      const note = el("div", `ag-note${st?.guard === "terminal_tools" ? " warn" : ""}`);
      note.textContent = st?.guard === "terminal_tools" ? t("agents.guardPartialDesc", { agent: ag.name }) : t("agents.guardFullDesc");
      body.append(note);
    }

    const actions = el("div", "s-row row-gap");
    actions.append(el("div", "s-label"));
    const btns = el("div", "s-control row-gap");
    if (!isDefault) {
      const b = el("button", "ghost-btn", t("agents.makeDefault"));
      b.disabled = !installed;
      b.addEventListener("click", () => setDefault({ agent: ag.id }));
      btns.append(b);
    }
    if (installed && !ag.custom) {
      const b = el("button", "ghost-btn", t("agents.signIn"));
      b.title = t("agents.signInTip", { agent: ag.name });
      b.addEventListener("click", async () => {
        try {
          const cmd = await invoke("agent_interactive_command", { agent: ag.id });
          closeSettings();
          await activeTab.split(activeTab.activePane, "row", cmd);
        } catch (e) { toast(String(e), "error"); }
      });
      btns.append(b);
    }
    actions.append(btns);
    if (btns.children.length) body.append(actions);

    row.append(head, body);
    return row;
  }));
}

function renderShortcuts() {
  const host = $("#shortcut-list");
  host.replaceChildren(...shortcutGroups().map(([groupKey, items]) => {
    const group = el("div", "kb-group");
    const card = el("div", "s-card");
    for (const [labelKey, combos] of items) {
      const row = el("div", "kb-row");
      const keys = el("span", "kb-keys");
      combos.forEach((parts, i) => {
        if (i) keys.append(el("span", "unit", "/"));
        for (const part of parts) keys.append(el("kbd", null, part));
      });
      row.append(el("span", null, t(labelKey)), keys);
      card.append(row);
    }
    group.append(el("div", "s-group-title", t(groupKey)), card);
    return group;
  }));
}

function closeSettings() {
  if ($("#settings").classList.contains("hidden")) return;
  // Flush pending saves so closing right after typing doesn't lose anything.
  if (configSaveTimer) { clearTimeout(configSaveTimer); invoke("save_config", { config }); }
  $("#settings").classList.add("hidden");
  activeTab?.activePane?.term.focus();
}

// ----- Guard settings -----
function fillGuard() {
  setSwitch($("#guard-enabled"), guardDraft.enabled);
  renderGuardEnabled();
  renderSeg($("#guard-default"), GUARD_ACTIONS.map((a) => ({ value: a, label: t(`action.${a}`), cls: `a-${a}` })), guardDraft.default_action, (v) => {
    guardDraft.default_action = v;
    saveGuardSoon();
  });
  $("#guard-timeout").value = guardDraft.ask_timeout_secs;
  renderRules();
  runGuardTest();
}

function renderGuardEnabled() {
  for (const g of document.querySelectorAll(".guard-dependent")) g.classList.toggle("disabled", !guardDraft.enabled);
}

function renderRules() {
  const host = $("#rules");
  host.replaceChildren();
  const actionOptions = GUARD_ACTIONS.map((a) => `<option value="${a}">${esc(t(`action.${a}`))}</option>`).join("");
  guardDraft.rules.forEach((r, i) => {
    const row = el("div", `rule a-${r.action}${r.enabled ? "" : " off"}`);
    row.innerHTML = `
      <button class="switch en" role="switch" aria-checked="${r.enabled}" title="${esc(t("guard.ruleEnabled"))}"><span></span></button>
      <input class="name" spellcheck="false" aria-label="${esc(t("guard.colName"))}" />
      <input class="tool" spellcheck="false" aria-label="${esc(t("guard.colTool"))}" title="${esc(t("guard.colTool"))}" placeholder="${esc(t("guard.colTool"))}" />
      <input class="pattern" spellcheck="false" aria-label="${esc(t("guard.colPattern"))}" title="${esc(t("guard.colPattern"))}" placeholder="${esc(t("guard.colPattern"))}" />
      <select class="action" aria-label="${esc(t("guard.colAction"))}">${actionOptions}</select>
      <div class="rule-btns">
        <button data-mv="-1" title="${esc(t("guard.moveUp"))}" aria-label="${esc(t("guard.moveUp"))}">↑</button>
        <button data-mv="1" title="${esc(t("guard.moveDown"))}" aria-label="${esc(t("guard.moveDown"))}">↓</button>
        <button data-del title="${esc(t("guard.deleteRule"))}" aria-label="${esc(t("guard.deleteRule"))}">✕</button>
      </div>`;
    $(".name", row).value = ruleName(r.name);
    $(".tool", row).value = r.tool;
    $(".pattern", row).value = r.pattern;
    $(".action", row).value = r.action;
    $(".action", row).addEventListener("change", (e) => { row.classList.remove("a-allow", "a-ask", "a-deny"); row.classList.add(`a-${e.target.value}`); rulesChanged(); });
    for (const inp of row.querySelectorAll("input")) inp.addEventListener("input", () => { validateRow(row); rulesChanged(); });
    const sw = $(".en", row);
    onSwitch(sw, (on) => { row.classList.toggle("off", !on); rulesChanged(); });
    $(".rule-btns", row).addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      readRules();
      if (b.hasAttribute("data-del")) guardDraft.rules.splice(i, 1);
      else {
        const j = i + Number(b.dataset.mv);
        if (j < 0 || j >= guardDraft.rules.length) return;
        [guardDraft.rules[i], guardDraft.rules[j]] = [guardDraft.rules[j], guardDraft.rules[i]];
      }
      renderRules();
      rulesChanged();
    });
    host.append(row);
    validateRow(row);
  });
}

// JS regex syntax differs slightly from Rust's; this only flags obvious typos.
// The backend validates again before saving.
function validateRow(row) {
  for (const cls of ["tool", "pattern"]) {
    const inp = $(`.${cls}`, row);
    let ok = true;
    try { new RegExp(inp.value.replace(/^\(\?i\)/, "")); } catch { ok = false; }
    inp.classList.toggle("invalid", !ok);
  }
}

function readRules() {
  guardDraft.rules = [...document.querySelectorAll("#rules .rule")].map((row) => ({
    enabled: isOn($(".en", row)),
    name: ruleNameKey($(".name", row).value.trim()) || t("guard.newRule"),
    tool: $(".tool", row).value.trim() || ".*",
    pattern: $(".pattern", row).value,
    action: $(".action", row).value,
  }));
  return guardDraft;
}

function rulesChanged() {
  readRules();
  runGuardTest();
  saveGuardSoon();
}

function saveGuardSoon() {
  clearTimeout(guardSaveTimer);
  guardSaveTimer = setTimeout(async () => {
    const error = $("#guard-error");
    if ($("#rules .invalid")) {
      error.textContent = t("guard.invalid");
      error.classList.remove("hidden");
      return;
    }
    try {
      await invoke("save_guard", { guard: guardDraft });
      error.classList.add("hidden");
      flashSaved();
    } catch (e) {
      error.textContent = String(e);
      error.classList.remove("hidden");
    }
  }, 400);
}

let testTimer = 0;
function runGuardTest() {
  clearTimeout(testTimer);
  testTimer = setTimeout(async () => {
    const badge = $("#test-result");
    const subject = $("#test-subject").value;
    if (!subject.trim()) { badge.className = "badge"; badge.textContent = "—"; return; }
    try {
      const d = await invoke("test_guard", { guard: guardDraft, tool: $("#test-tool").value, subject });
      const action = t(`action.${d.action}`);
      badge.className = `badge ${d.action}`;
      badge.textContent = d.rule ? t("guard.testResultRule", { action, rule: ruleName(d.rule) }) : t("guard.testResultDefault", { action });
    } catch (e) {
      badge.className = "badge deny";
      badge.textContent = String(e);
    }
  }, 120);
}


async function applyFont() {
  await preloadFonts();
  for (const p of panes.values()) {
    p.term.options.fontFamily = config.font_family;
    p.term.options.fontSize = config.font_size;
    p.doFit();
  }
}

function zoomFont(delta) {
  updateConfig({ font_size: delta === 0 ? 13 : Math.min(32, Math.max(8, config.font_size + delta)) });
  $("#set-font-size").value = config.font_size;
  applyFont();
}

// ---------------------------------------------------------------------------
// Language
// ---------------------------------------------------------------------------
function applyLanguage() {
  const lang = resolveLanguage(config.language);
  setLanguage(lang);
  applyI18n();
  $("#ask-allow-key").textContent = shortcutLabel("allow");
  invoke("set_ui_language", { lang }).catch(() => {});
  for (const tab of tabs) {
    tab.renderHeader();
    tab.panes.forEach((p) => p.updateTags());
    if ($(".chat-empty", tab.chat.log)) tab.chat.renderEmpty();
  }
  activeTab?.chat.syncComposer();
  updateContextTip();
  if (!$("#history-panel").classList.contains("hidden")) refreshHistory();
  if (!$("#settings").classList.contains("hidden")) {
    fillSettings();
    showSection(currentSection);
  }
}

// ---------------------------------------------------------------------------
// Keyboard shortcuts (Ghostty-style)
// ---------------------------------------------------------------------------
function setupKeys() {
  document.addEventListener("keydown", (e) => {
    if (!$("#prompt-dialog").classList.contains("hidden")) {
      if (e.key === "Escape") { e.preventDefault(); closePromptDialog(null); }
      return;
    }
    if (!$("#confirm").classList.contains("hidden")) {
      if (e.key === "Escape") { e.preventDefault(); closeConfirm(false); }
      return;
    }
    const id = matchShortcut(e);
    if (!$("#guard-ask").classList.contains("hidden")) {
      if (e.key === "Escape") { e.preventDefault(); answerAsk(false); }
      else if (id === "allow") { e.preventDefault(); answerAsk(true); }
      return;
    }
    if (!$("#settings").classList.contains("hidden")) {
      if (e.key === "Escape") { e.preventDefault(); closeSettings(); }
      return;
    }
    if (!id || !activeTab || id === "allow") return;
    if (!$("#ctx-menu").classList.contains("hidden")) hideContextMenu();
    const tab = activeTab, pane = tab.activePane;
    const tabNumber = /^tab(\d)$/.exec(id);
    if (tabNumber) {
      activateTab(tabNumber[1] === "9" ? tabs[tabs.length - 1] : tabs[Number(tabNumber[1]) - 1]);
    } else {
      switch (id) {
        case "newTab": openTab(); break;
        case "profileMenu": openProfileMenu(); break;
        case "closeTab": closeTab(tab); break;
        case "closePane": tab.closePane(pane); break;
        case "splitRight": tab.split(pane, "row"); break;
        case "splitDown": tab.split(pane, "col"); break;
        case "prevTab": activateTab(tabs[(tabs.indexOf(tab) - 1 + tabs.length) % tabs.length]); break;
        case "nextTab": activateTab(tabs[(tabs.indexOf(tab) + 1) % tabs.length]); break;
        case "prevPane": tab.cyclePane(-1); break;
        case "nextPane": tab.cyclePane(1); break;
        case "paneLeft": tab.focusDirection(-1, 0); break;
        case "paneRight": tab.focusDirection(1, 0); break;
        case "paneUp": tab.focusDirection(0, -1); break;
        case "paneDown": tab.focusDirection(0, 1); break;
        case "clear": pane.term.clear(); break;
        case "fontUp": zoomFont(1); break;
        case "fontDown": zoomFont(-1); break;
        case "fontReset": zoomFont(0); break;
        case "sidebar": toggleSidebar(); break;
        case "focusPrompt":
          if (document.activeElement === $("#prompt")) pane.term.focus();
          else toggleSidebar(true);
          break;
        case "settings": openSettings(); break;
        case "history": toggleHistory(); break;
        case "copy": copySelection(pane); break;
        case "paste": pasteInto(pane); break;
      }
    }
    e.preventDefault();
    e.stopPropagation();
  }, true);
}

// ---------------------------------------------------------------------------
// Clipboard, context menu and title dialog
// ---------------------------------------------------------------------------
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); } catch { await invoke("clipboard_write", { text }).catch(() => {}); }
}

function copySelection(pane) {
  const text = pane.term.getSelection();
  if (text) copyText(text);
}

async function pasteInto(pane) {
  if (!pane.alive || pane.readOnly) return;
  const text = await invoke("clipboard_read").catch(() => "");
  // xterm adds bracketed-paste markers when the program asked for them.
  if (text) pane.term.paste(text);
  pane.term.focus();
}

async function resetTerminal(pane) {
  pane.term.reset();
  // A reset empties the screen, prompt included; ask an idle shell to draw it again.
  const fg = await invoke("pty_foreground", { id: pane.id }).catch(() => null);
  if (pane.alive && !pane.readOnly && fg?.shell_idle) invoke("pty_write", { id: pane.id, data: "\x0c" });
}

let ctxItems = [];
// Which control opened the menu, and when it last closed: lets a second click on the
// same button close the menu instead of closing it (mousedown) and reopening it (click).
let ctxOwner = null;
let ctxHiddenAt = 0;

function hideContextMenu() {
  const menu = $("#ctx-menu");
  if (!menu.classList.contains("hidden")) ctxHiddenAt = performance.now();
  menu.classList.add("hidden");
  ctxItems = [];
}

function showContextMenu(pane, x, y) {
  const tab = pane.tab;
  tab.focusPane(pane, false);
  const hint = (id) => (shortcutParts(id).length ? shortcutLabel(id) : "");
  const nativeKey = (letter) => (IS_MAC ? `⌘${letter}` : "");
  const hasSelection = pane.term.hasSelection();
  const entries = [
    hasSelection && { label: t("ctx.copy"), hint: hint("copy") || nativeKey("C"), run: () => copySelection(pane) },
    { label: t("ctx.paste"), hint: hint("paste") || nativeKey("V"), disabled: pane.readOnly, run: () => pasteInto(pane) },
    "-",
    { label: t("ctx.splitRight"), hint: hint("splitRight"), run: () => tab.split(pane, "row") },
    { label: t("ctx.splitLeft"), run: () => tab.split(pane, "row", undefined, { before: true }) },
    { label: t("ctx.splitDown"), hint: hint("splitDown"), run: () => tab.split(pane, "col") },
    { label: t("ctx.splitUp"), run: () => tab.split(pane, "col", undefined, { before: true }) },
    "-",
    { label: t("ctx.clear"), hint: hint("clear"), run: () => pane.term.clear() },
    { label: t("ctx.reset"), run: () => resetTerminal(pane) },
    { label: t("ctx.readOnly"), checked: pane.readOnly, run: () => pane.setReadOnly(!pane.readOnly) },
    "-",
    { label: t("ctx.changeTabTitle"), run: () => renameTab(tab) },
    { label: t("ctx.changeTerminalTitle"), run: () => renamePane(pane) },
  ].filter(Boolean);

  showMenu(entries, x, y, { restoreFocus: () => pane.term.focus() });
}

/**
 * Shows the shared popup menu. An entry is "-" (separator), { heading }, { note }, or an item:
 * { label, hint, disabled, checked, run, alt }. `alt` runs on right-click or ⌥-click instead of `run`.
 */
function showMenu(entries, x, y, { restoreFocus, owner = null, focusFirst = false } = {}) {
  const menu = $("#ctx-menu");
  menu.replaceChildren();
  ctxItems = [];
  ctxOwner = owner;
  const checkable = entries.some((en) => typeof en === "object" && "checked" in en);
  for (const en of entries) {
    if (en === "-") { menu.append(el("div", "ctx-sep")); continue; }
    if (en.heading) { menu.append(el("div", "ctx-heading", en.heading)); continue; }
    if (en.note) { menu.append(el("div", "ctx-note", en.note)); continue; }
    const b = el("button", "ctx-item");
    b.type = "button";
    b.setAttribute("role", "menuitem");
    b.disabled = !!en.disabled;
    if (checkable) b.append(el("span", "ctx-check", en.checked ? "✓" : ""));
    b.append(el("span", "ctx-label", en.label), el("span", "ctx-hint", en.hint ?? ""));
    const choose = (fn) => { hideContextMenu(); fn(); if (!$("#prompt-dialog").offsetParent) restoreFocus?.(); };
    b.addEventListener("click", (e) => choose(e.altKey && en.alt ? en.alt : en.run));
    if (en.alt) b.addEventListener("contextmenu", (e) => { e.preventDefault(); choose(en.alt); });
    menu.append(b);
    if (!en.disabled) ctxItems.push(b);
  }
  menu.classList.remove("hidden");
  // Keep the menu inside the window.
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(6, Math.min(x, window.innerWidth - r.width - 6))}px`;
  menu.style.top = `${Math.max(6, Math.min(y, window.innerHeight - r.height - 6))}px`;
  if (focusFirst) ctxItems[0]?.focus();
}

// The `+` menu: pick what the new tab runs, or make a profile the default.
async function openProfileMenu({ toggle = false } = {}) {
  if (toggle && ctxOwner === "tabs" && performance.now() - ctxHiddenAt < 300) return;
  const hosts = await invoke("ssh_hosts").catch(() => []);
  const anchor = $("#new-tab").getBoundingClientRect();
  const entries = profileMenuEntries({
    config,
    hosts,
    onOpen: (id) => openTab(id),
    onSetDefault: (p) => {
      updateConfig({ default_profile: p.id });
      toast(t("profile.nowDefault", { name: profileName(p) }), "ok", 2500);
    },
    onManage: () => openSettings("profiles"),
  });
  showMenu(entries, anchor.left, anchor.bottom + 4, { owner: "tabs", focusFirst: true, restoreFocus: () => activeTab?.activePane?.term.focus() });
}

function setupContextMenu() {
  const menu = $("#ctx-menu");
  document.addEventListener("contextmenu", (e) => {
    const paneEl = e.target.closest(".pane");
    if (paneEl) {
      e.preventDefault();
      const pane = [...panes.values()].find((p) => p.el === paneEl);
      if (pane) showContextMenu(pane, e.clientX, e.clientY);
      return;
    }
    if (e.target.closest("#new-tab, #tab-menu")) { e.preventDefault(); openProfileMenu(); return; }
    hideContextMenu();
    // Keep the system menu for text fields and selected text; hide the WebView's own (Reload…).
    const editable = e.target.closest("input, textarea, [contenteditable]");
    if (!editable && !window.getSelection()?.toString()) e.preventDefault();
  });
  document.addEventListener("mousedown", (e) => { if (!e.target.closest("#ctx-menu")) hideContextMenu(); }, true);
  window.addEventListener("blur", hideContextMenu);
  window.addEventListener("resize", hideContextMenu);
  menu.addEventListener("keydown", (e) => {
    const i = ctxItems.indexOf(document.activeElement);
    if (e.key === "ArrowDown") { e.preventDefault(); ctxItems[(i + 1) % ctxItems.length]?.focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); ctxItems[(i - 1 + ctxItems.length) % ctxItems.length]?.focus(); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); hideContextMenu(); activeTab?.activePane?.term.focus(); }
  });
  // Keys typed while the menu is open belong to it, not to the terminal underneath.
  document.addEventListener("keydown", (e) => {
    if (menu.classList.contains("hidden") || e.metaKey || e.ctrlKey) return;
    if (["ArrowDown", "ArrowUp"].includes(e.key) && !menu.contains(document.activeElement)) { e.preventDefault(); ctxItems[0]?.focus(); }
    else if (e.key === "Escape") { e.preventDefault(); hideContextMenu(); }
  }, true);
}

let promptResolve = null;
function promptDialog({ title, body, value = "", placeholder = "" }) {
  $("#pd-title").textContent = title;
  $("#pd-body").textContent = body;
  const input = $("#pd-input");
  input.value = value;
  input.placeholder = placeholder;
  $("#prompt-dialog").classList.remove("hidden");
  input.focus();
  input.select();
  return new Promise((resolve) => { promptResolve = resolve; });
}

function closePromptDialog(result) {
  $("#prompt-dialog").classList.add("hidden");
  promptResolve?.(result);
  promptResolve = null;
  activeTab?.activePane?.term.focus();
}

function setupPromptDialog() {
  $("#pd-ok").addEventListener("click", () => closePromptDialog($("#pd-input").value.trim()));
  $("#pd-cancel").addEventListener("click", () => closePromptDialog(null));
  $("#pd-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); closePromptDialog($("#pd-input").value.trim()); }
  });
}

async function renameTab(tab) {
  const value = await promptDialog({ title: t("title.tab"), body: t("title.hint"), value: tab.customTitle, placeholder: t("title.placeholder") });
  if (value === null) return;
  tab.customTitle = value;
  tab.renderHeader();
}

async function renamePane(pane) {
  const value = await promptDialog({ title: t("title.terminal"), body: t("title.hint"), value: pane.customTitle, placeholder: t("title.placeholder") });
  if (value === null) return;
  pane.customTitle = value;
  pane.updateTags();
  pane.tab.renderHeader();
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
// The webview only exposes system fonts, so user-installed ones (e.g. Nerd Fonts for
// prompt icons) are registered from their files. The WebGL renderer caches glyphs on
// first draw, so this must finish before any terminal opens.
const registeredFonts = new Set();
async function preloadFonts() {
  const families = config.font_family.split(",").map((f) => f.trim()).filter((f) => f && !/^(monospace|serif|sans-serif)$/.test(f));
  const files = await invoke("resolve_fonts", { families }).catch(() => []);
  for (const f of files) {
    if (registeredFonts.has(f.path)) continue;
    registeredFonts.add(f.path);
    const face = new FontFace(f.family, `url("${window.__TAURI__.core.convertFileSrc(f.path)}")`, { weight: f.weight, style: f.style });
    document.fonts.add(face);
  }
  await Promise.allSettled(families.map((f) => document.fonts.load(`${config.font_size}px ${f}`, "\ue0b0\uf015 abc")));
}

async function main() {
  setKeyLabeler(shortcutLabel);
  config = await invoke("get_config");
  applyLanguage();
  await preloadFonts();
  $("#ctx-toggle").checked = config.include_terminal_context;

  await listen("pty-output", (e) => {
    const pane = panes.get(e.payload.id);
    if (!pane) return;
    pane.lastOutput = performance.now();
    pane.term.write(e.payload.data);
  });
  await listen("pty-exit", (e) => {
    const pane = panes.get(e.payload);
    if (pane) { pane.alive = false; pane.tab.closePane(pane); }
  });
  await listen("agent-event", (e) => runs.get(e.payload.run_id)?.handleLine(e.payload.line));
  await listen("agent-done", (e) => runs.get(e.payload.run_id)?.onDone(e.payload));
  await listen("menu", (e) => { if (e.payload === "settings") openSettings(); });

  $("#new-tab").addEventListener("click", () => openTab());
  $("#tab-menu").addEventListener("click", () => openProfileMenu({ toggle: true }));
  setupSidebar();
  setupGuardAsk();
  setupHistory();
  setupAgentMenu();
  await listen("agent-tool", (e) => runAgentTool(e.payload));
  setupSettings();
  setupConfirm();
  setupPromptDialog();
  setupContextMenu();
  setupKeys();
  window.addEventListener("resize", () => activeTab?.panes.forEach((p) => p.doFit()));
  await newTab(null).catch(async (e) => {
    // A default profile that can't start (say an SSH host that went away) must not leave an empty window.
    toast(String(e?.message ?? e), "error");
    await newTab(null, undefined, { profile: LOCAL });
  });
  refreshAgentStatus();
}

main().catch((e) => {
  document.body.innerHTML = `<pre style="color:#f7768e;padding:20px">${esc(e?.stack || e)}</pre>`;
});
