// Agent registry and output adapters.
//
// The chat UI understands one event shape — Claude Code's stream-json
// (system/init, stream_event deltas, assistant and user messages, result).
// Each adapter turns another agent's output into that shape, so tool cards,
// thinking blocks, history and resume work the same for every agent.

const CLAUDE_MODELS = [
  { value: "opus", name: "Opus 5.5", descKey: "model.opus" },
  { value: "sonnet", name: "Sonnet 5.5", descKey: "model.sonnet" },
  { value: "fable", name: "Fable 5.1", descKey: "model.fable" },
  { value: "haiku", name: "Haiku 5.5", descKey: "model.haiku" },
];

// efforts: reasoning levels the agent accepts (subset of low…max).
// thinking: whether the thinking toggle changes anything for this agent.
export const AGENTS = [
  { id: "claude", name: "Claude Code", short: "Claude", format: "claude", models: CLAUDE_MODELS, efforts: ["low", "medium", "high", "xhigh", "max"], thinking: true },
  { id: "codex", name: "Codex", short: "Codex", format: "codex", models: [], efforts: ["low", "medium", "high", "xhigh"], thinking: true },
  { id: "antigravity", name: "Antigravity", short: "Antigravity", format: "gemini", models: [], efforts: ["low", "medium", "high"], thinking: false },
  { id: "gemini", name: "Gemini CLI", short: "Gemini", format: "gemini", models: [], efforts: [], thinking: false },
  { id: "cursor", name: "Cursor Agent", short: "Cursor", format: "cursor", models: [], efforts: [], thinking: false },
  { id: "opencode", name: "OpenCode", short: "OpenCode", format: "opencode", models: [], efforts: ["low", "medium", "high", "max"], thinking: true },
  { id: "custom", name: "Custom agent", short: "Custom", format: "text", models: [], efforts: [], thinking: false, custom: true },
];

export const agentInfo = (id) => AGENTS.find((a) => a.id === id) ?? AGENTS[0];

// ---------------------------------------------------------------------------
// Normalizer: emits Claude-shaped events from simple calls.
// ---------------------------------------------------------------------------
class Normalizer {
  constructor(ctx) {
    this.ctx = ctx;
    this.out = [];
    this.sessionId = null;
    this.text = null; // open streamed text block: { id, acc }
    this.seq = 0;
    this.started = performance.now();
    this.hadResult = false;
    this.hadError = false;
    this.cost = 0;
    this.toolNames = new Map();
  }

  drain() {
    const out = this.out;
    this.out = [];
    return out;
  }

  init(sessionId, model) {
    if (!sessionId || this.sessionId === sessionId) return;
    this.sessionId = sessionId;
    this.out.push({ type: "system", subtype: "init", session_id: sessionId, model: model || this.ctx.agentName, cwd: this.ctx.cwd });
  }

  textDelta(text) {
    if (!text) return;
    if (!this.text) {
      const id = `${this.ctx.prefix}-msg-${++this.seq}`;
      this.text = { id, acc: "" };
      this.out.push({ type: "stream_event", event: { type: "message_start", message: { id } } });
      this.out.push({ type: "stream_event", event: { type: "content_block_start", content_block: { type: "text" } } });
    }
    this.text.acc += text;
    this.out.push({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } } });
  }

  closeText() {
    if (!this.text) return;
    const { id, acc } = this.text;
    this.text = null;
    this.out.push({ type: "stream_event", event: { type: "content_block_stop" } });
    // Already rendered from the deltas; this copy is what history records.
    this.out.push({ type: "assistant", message: { id, role: "assistant", content: [{ type: "text", text: acc }] } });
  }

  message(text) {
    this.closeText();
    if (text?.trim()) this.out.push({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
  }

  thinking(text) {
    this.closeText();
    if (text?.trim()) this.out.push({ type: "assistant", message: { role: "assistant", content: [{ type: "thinking", thinking: text }] } });
  }

  toolUse(id, name, input) {
    this.closeText();
    if (this.toolNames.has(id)) return;
    this.toolNames.set(id, name);
    this.out.push({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name, input: input ?? {} }] } });
  }

  toolResult(id, text, isError = false) {
    this.out.push({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text ?? "", is_error: !!isError }] } });
  }

  // Non-fatal notice (reconnects, deprecations): a quiet line, not an error box.
  warn(text) {
    if (text) this.out.push({ type: "agent_warning", text: String(text) });
  }

  status(text) {
    if (text) this.out.push({ type: "agent_status", text: String(text) });
  }

  error(text) {
    this.closeText();
    this.hadError = true;
    if (text) this.out.push({ type: "agent_error", text: String(text) });
  }

  result(ok, { text, durationMs, cost, turns } = {}) {
    this.closeText();
    this.hadResult = true;
    this.out.push({
      type: "result",
      subtype: ok ? "success" : "error",
      is_error: !ok,
      duration_ms: durationMs ?? Math.round(performance.now() - this.started),
      total_cost_usd: cost ?? (this.cost || null),
      num_turns: turns,
      result: ok ? undefined : text,
      session_id: this.sessionId,
    });
  }

  // Called when the process exits; covers agents without a final event.
  finish(code) {
    this.closeText();
    if (!this.hadResult && code != null) this.result(code === 0 && !this.hadError);
  }
}

const parse = (line) => {
  try { return JSON.parse(line); } catch { return null; }
};

const isClaudeEvent = (o) =>
  ["system", "assistant", "user", "stream_event"].includes(o.type) || (o.type === "result" && "subtype" in o);

const resultText = (v) => {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (Array.isArray(v?.content)) return v.content.map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
  return JSON.stringify(v, null, 2);
};

// ---------------------------------------------------------------------------
// Per-format adapters: push(line) and finish(code) return Claude-shaped events.
// ---------------------------------------------------------------------------
const ADAPTERS = {
  // Claude Code stream-json: already the native shape.
  claude() {
    return {
      push(line) {
        const o = parse(line);
        return o ? [o] : [];
      },
      // Claude Code always ends with a result event.
      finish: () => [],
    };
  },

  // Gemini CLI stream-json (init/message/tool_use/tool_result/error/result).
  // Antigravity's agy descends from Gemini CLI; Claude-shaped lines are passed
  // through too, so either schema works.
  gemini(ctx) {
    const n = new Normalizer(ctx);
    return {
      push(line) {
        const o = parse(line);
        if (!o) { n.textDelta(`${line}\n`); return n.drain(); }
        if (isClaudeEvent(o)) {
          if (o.type === "system" && o.session_id) n.sessionId = o.session_id;
          if (o.type === "result") n.hadResult = true;
          return [...n.drain(), o];
        }
        switch (o.type) {
          case "init": n.init(o.session_id, o.model); break;
          case "message":
            if (o.role === "assistant") n.textDelta(typeof o.content === "string" ? o.content : resultText(o.content));
            break;
          case "tool_use": n.toolUse(o.tool_id, o.tool_name, o.parameters); break;
          case "tool_result": n.toolResult(o.tool_id, o.output ?? o.error?.message ?? "", o.status === "error"); break;
          case "error": if (o.severity === "warning") n.warn(o.message); else n.error(o.message); break;
          case "result":
            n.result(o.status !== "error", { text: o.error?.message, durationMs: o.stats?.duration_ms });
            break;
        }
        return n.drain();
      },
      finish(code) { n.finish(code); return n.drain(); },
    };
  },

  // Codex `exec --json`: thread/turn/item events.
  codex(ctx) {
    const n = new Normalizer(ctx);
    const seenText = new Map();
    let turns = 0;
    let lastError = null;
    const kind = (item) => {
      const t = item.type ?? item.item_type;
      return t === "assistant_message" ? "agent_message" : t;
    };
    return {
      push(line) {
        const o = parse(line);
        if (!o) return [];
        const item = o.item;
        switch (o.type) {
          case "thread.started": n.init(o.thread_id, ctx.model || ctx.agentName); break;
          case "turn.started": turns++; break;
          case "item.started":
          case "item.updated":
          case "item.completed": {
            const done = o.type === "item.completed";
            switch (kind(item)) {
              case "agent_message": {
                const prev = seenText.get(item.id) ?? "";
                const text = item.text ?? "";
                if (text.startsWith(prev)) n.textDelta(text.slice(prev.length));
                else n.textDelta(text);
                seenText.set(item.id, text);
                if (done) n.closeText();
                break;
              }
              case "reasoning":
                if (done) n.thinking(item.text);
                break;
              case "command_execution":
                n.toolUse(item.id, "Bash", { command: item.command });
                if (done) n.toolResult(item.id, item.aggregated_output ?? "", (item.exit_code ?? 0) !== 0 || ["failed", "declined"].includes(item.status));
                break;
              case "file_change":
                if (done) {
                  const changes = item.changes ?? [];
                  n.toolUse(item.id, "Edit", { file_path: changes.map((c) => c.path).join(", "), changes });
                  n.toolResult(item.id, changes.map((c) => `${c.kind ?? "update"} ${c.path}`).join("\n"), item.status === "failed");
                }
                break;
              case "mcp_tool_call":
                n.toolUse(item.id, `mcp__${item.server}__${item.tool}`, item.arguments);
                if (done) n.toolResult(item.id, item.error?.message ?? resultText(item.result), !!item.error || item.status === "failed");
                break;
              case "web_search":
                n.toolUse(item.id, "WebSearch", { query: item.query });
                if (done) n.toolResult(item.id, "");
                break;
              case "todo_list":
                if (done) {
                  const todos = (item.items ?? []).map((t) => ({ content: t.text, status: t.completed ? "completed" : "pending" }));
                  n.toolUse(item.id, "TodoWrite", { todos });
                  n.toolResult(item.id, "");
                }
                break;
              case "error":
                // Codex reports warnings as error items; our own hook-trust flag
                // triggers one every run.
                if (!/dangerously-bypass-hook-trust/.test(item.message ?? "")) n.warn(item.message);
                break;
            }
            break;
          }
          case "turn.completed": n.result(true, { turns }); break;
          case "turn.failed": n.result(false, { text: o.error?.message, turns }); break;
          // Top-level errors are retries ("Reconnecting… 2/5"); turn.failed carries the real failure.
          case "error": n.status(o.message); lastError = o.message; break;
        }
        return n.drain();
      },
      finish(code) {
        if (code !== 0 && !n.hadResult && lastError) n.error(lastError);
        n.finish(code);
        return n.drain();
      },
    };
  },

  // Cursor Agent stream-json: Claude-like, plus tool_call started/completed events.
  cursor(ctx) {
    const n = new Normalizer(ctx);
    const NAMES = {
      shellToolCall: "Bash", readToolCall: "Read", editToolCall: "Edit", writeToolCall: "Write",
      deleteToolCall: "Delete", grepToolCall: "Grep", globToolCall: "Glob", lsToolCall: "LS",
      todoToolCall: "TodoWrite", webSearchToolCall: "WebSearch",
    };
    const describe = (tc) => {
      if (tc?.function) {
        let args = tc.function.arguments;
        try { args = JSON.parse(args); } catch { /* keep as text */ }
        return { name: tc.function.name, args, result: tc.function.result };
      }
      const key = Object.keys(tc ?? {})[0];
      const body = tc?.[key] ?? {};
      return { name: NAMES[key] ?? key?.replace(/ToolCall$/, ""), args: body.args, result: body.result };
    };
    return {
      push(line) {
        const o = parse(line);
        if (!o) return [];
        if (o.type === "tool_call") {
          const { name, args, result } = describe(o.tool_call);
          n.toolUse(o.call_id, name, args);
          if (o.subtype === "completed") {
            const ok = result?.success ?? result;
            const err = result?.error;
            const text = err ? resultText(err.message ?? err) : ok?.stdout != null ? `${ok.stdout}${ok.stderr ? `\n${ok.stderr}` : ""}` : resultText(ok?.content ?? ok);
            n.toolResult(o.call_id, text, !!err || (ok?.exitCode ?? 0) !== 0);
          }
          return n.drain();
        }
        if (o.type === "result") n.hadResult = true;
        if (o.type === "system" && o.session_id) n.sessionId = o.session_id;
        return [...n.drain(), o];
      },
      finish(code) { n.finish(code); return n.drain(); },
    };
  },

  // OpenCode `run --format json`: {type, sessionID, part} events; tools are
  // reported once, when they finish.
  opencode(ctx) {
    const n = new Normalizer(ctx);
    const NAMES = { bash: "Bash", edit: "Edit", write: "Write", read: "Read", glob: "Glob", grep: "Grep", webfetch: "WebFetch", todowrite: "TodoWrite", list: "LS" };
    return {
      push(line) {
        const o = parse(line);
        if (!o) return [];
        if (o.sessionID) n.init(o.sessionID, ctx.model || ctx.agentName);
        const part = o.part ?? {};
        switch (o.type) {
          case "text": n.message(part.text); break;
          case "reasoning": n.thinking(part.text); break;
          case "tool_use": {
            const id = part.callID ?? part.id;
            const state = part.state ?? {};
            n.toolUse(id, NAMES[part.tool] ?? part.tool, state.input);
            n.toolResult(id, state.status === "error" ? state.error : state.output, state.status === "error");
            break;
          }
          case "step_finish": n.cost += Number(part.cost) || 0; break;
          case "error": n.error(o.error?.data?.message ?? o.error?.message ?? o.error?.name); break;
        }
        return n.drain();
      },
      finish(code) { n.finish(code); return n.drain(); },
    };
  },

  // Plain text output: every line is part of the answer.
  text(ctx) {
    const n = new Normalizer(ctx);
    return {
      push(line) { n.textDelta(`${line}\n`); return n.drain(); },
      finish(code) { n.finish(code); return n.drain(); },
    };
  },
};

export function createAdapter(format, ctx) {
  return (ADAPTERS[format] ?? ADAPTERS.text)(ctx);
}

export const FORMATS = ["text", "claude", "gemini", "codex"];
