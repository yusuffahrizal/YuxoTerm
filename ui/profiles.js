// Profiles: what a new tab or pane runs (a local shell, an SSH host, or any command).
// The backend resolves a profile id into a real command (src-tauri/src/pty.rs); this module
// holds the matching UI: the `+` menu entries and the Settings → Profiles panel.
import { t } from "./i18n.js";
import { el } from "./util.js";

/** The built-in local shell. Always exists; programmatic opens (agent tools, login) use it. */
export const LOCAL = "local";
/** Ids of hosts read from ~/.ssh/config are `ssh:<alias>`. */
export const SSH = "ssh:";

const KINDS = ["shell", "ssh", "command"];

const virtualSsh = (alias) => ({ id: SSH + alias, name: alias, kind: "ssh", command: "", args: "", ssh_host: alias, cwd: "", env: {} });

/** Mirrors `AppConfig::profile` in config.rs. */
export function resolveProfile(config, id) {
  if (id?.startsWith(SSH)) return virtualSsh(id.slice(SSH.length));
  return config.profiles.find((p) => p.id === id) ?? config.profiles.find((p) => p.id === LOCAL);
}

/** Mirrors `AppConfig::default_profile`. */
export function defaultProfile(config) {
  const id = config.default_profile;
  const known = id?.startsWith(SSH) || config.profiles.some((p) => p.id === id);
  return resolveProfile(config, known ? id : LOCAL);
}

export const profileName = (p) => p.name || (p.id === LOCAL ? t("profile.local") : p.ssh_host || p.command || p.id);

function profileDetail(p) {
  if (p.kind === "ssh") return `ssh ${[p.args, p.ssh_host].filter(Boolean).join(" ")}`;
  return [p.command || (p.kind === "shell" ? "$SHELL" : ""), p.args].filter(Boolean).join(" ");
}

/**
 * Entries for the `+` menu, in the shape `showMenu` takes. `hosts` come from ~/.ssh/config.
 * Left-click opens a tab; right-click (or ⌥-click) makes the profile the default.
 */
export function profileMenuEntries({ config, hosts, onOpen, onSetDefault, onManage }) {
  const current = defaultProfile(config).id;
  const item = (p, hint) => ({
    label: profileName(p),
    hint,
    checked: p.id === current,
    run: () => onOpen(p.id),
    alt: () => onSetDefault(p),
  });
  const local = config.profiles.filter((p) => p.kind !== "ssh").map((p) => item(p, ""));
  const stored = config.profiles.filter((p) => p.kind === "ssh");
  const covered = new Set(stored.map((p) => p.ssh_host));
  const ssh = [
    ...stored.map((p) => item(p, p.ssh_host)),
    ...hosts.filter((h) => !covered.has(h.alias)).map((h) => item(virtualSsh(h.alias), [h.user, h.hostname].filter(Boolean).join("@"))),
  ];
  return [
    { heading: t("profile.headingLocal") },
    ...local,
    "-",
    { heading: t("profile.headingSsh") },
    ...(ssh.length ? ssh : [{ note: t("profile.noSsh") }]),
    "-",
    { note: t("profile.defaultNote") },
    { label: t("profile.manage"), run: onManage },
  ];
}

// ---------------------------------------------------------------------------
// Settings → Profiles
// ---------------------------------------------------------------------------

const envToText = (env) => Object.entries(env ?? {}).map(([k, v]) => `${k}=${v}`).join("\n");

function textToEnv(text) {
  const env = {};
  for (const line of text.split("\n")) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}

function field(label, control, desc) {
  const row = el("div", "s-row");
  const lab = el("div", "s-label");
  lab.append(el("div", null, label));
  if (desc) lab.append(el("div", "s-desc", desc));
  const wrap = el("div", "s-control wide");
  wrap.append(control);
  control.setAttribute("aria-label", label);
  row.append(lab, wrap);
  return row;
}

function input(value, placeholder, onInput, { mono = true, list } = {}) {
  const i = el("input", mono ? "mono" : "");
  i.spellcheck = false;
  i.value = value ?? "";
  if (placeholder) i.placeholder = placeholder;
  if (list) i.setAttribute("list", list);
  i.addEventListener("input", () => onInput(i.value));
  return i;
}

/**
 * Fills `root` with the profile settings. `hosts` and `shells` are what the backend found;
 * `update(patch)` saves a config change (debounced by the caller).
 */
export function renderProfileSettings(root, { config, hosts, shells, update, confirm }) {
  let open = null;
  const save = () => update({ profiles: config.profiles, default_profile: config.default_profile });

  const render = () => {
    root.replaceChildren();

    // Default profile
    const defaultGroup = el("div", "s-group");
    defaultGroup.append(el("div", "s-group-title", t("profile.defaultGroup")));
    const defaultCard = el("div", "s-card");
    const sel = el("select");
    const storedHosts = new Set(config.profiles.filter((p) => p.kind === "ssh").map((p) => p.ssh_host));
    for (const p of config.profiles) sel.append(new Option(profileName(p), p.id));
    const hostGroup = el("optgroup");
    hostGroup.label = t("profile.headingSsh");
    for (const h of hosts.filter((h) => !storedHosts.has(h.alias))) hostGroup.append(new Option(h.alias, SSH + h.alias));
    if (hostGroup.children.length) sel.append(hostGroup);
    // An ssh:<alias> default whose host was removed from ~/.ssh/config stays selectable.
    const current = defaultProfile(config).id;
    if (![...sel.options].some((o) => o.value === current)) sel.append(new Option(current.slice(SSH.length), current));
    sel.value = current;
    sel.addEventListener("change", () => { config.default_profile = sel.value; save(); });
    defaultCard.append(field(t("profile.defaultLabel"), sel, t("profile.defaultDesc")));
    defaultGroup.append(defaultCard);

    // Profile list
    const listGroup = el("div", "s-group");
    listGroup.append(el("div", "s-group-title", t("profile.listGroup")), el("p", "s-desc s-group-desc", t("profile.listDesc")));
    const card = el("div", "s-card profiles-card");
    for (const p of config.profiles) card.append(renderProfile(p));
    listGroup.append(card);

    const actions = el("div", "s-actions");
    for (const [kind, label] of [["shell", t("profile.addShell")], ["ssh", t("profile.addSsh")], ["command", t("profile.addCommand")]]) {
      const b = el("button", "ghost-btn", `+ ${label}`);
      b.addEventListener("click", () => {
        const p = { id: `p-${Date.now().toString(36)}`, name: "", kind, command: "", args: "", ssh_host: "", cwd: "", env: {} };
        p.name = { shell: t("profile.newShell"), ssh: t("profile.newSsh"), command: t("profile.newCommand") }[kind];
        config.profiles.push(p);
        open = p.id;
        save();
        render();
        root.querySelector(`[data-profile="${p.id}"] input`)?.select();
      });
      actions.append(b);
    }
    listGroup.append(actions);
    root.append(defaultGroup, listGroup);

    const shellList = el("datalist");
    shellList.id = "profile-shells";
    for (const s of shells) shellList.append(new Option(s));
    const hostList = el("datalist");
    hostList.id = "profile-hosts";
    for (const h of hosts) hostList.append(new Option(h.alias));
    root.append(shellList, hostList);
  };

  const renderProfile = (p) => {
    const wrap = el("div", "profile");
    wrap.dataset.profile = p.id;
    const isOpen = open === p.id;
    wrap.classList.toggle("open", isOpen);

    const head = el("div", "profile-head");
    const names = el("div", "profile-names");
    const title = el("div", "profile-name", profileName(p));
    const detail = el("div", "profile-detail mono", profileDetail(p));
    names.append(title, detail);
    const kind = el("span", `badge kind-${p.kind}`, t(`profile.kind.${p.kind}`));
    const edit = el("button", "ghost-btn", isOpen ? t("profile.done") : t("profile.edit"));
    edit.addEventListener("click", () => { open = isOpen ? null : p.id; render(); });
    head.append(names, kind, edit);
    if (p.id !== LOCAL) {
      const del = el("button", "ghost-btn danger", t("profile.delete"));
      del.addEventListener("click", async () => {
        const ok = await confirm({ title: t("profile.deleteTitle", { name: profileName(p) }), body: t("profile.deleteBody"), ok: t("profile.delete"), danger: true });
        if (!ok) return;
        config.profiles = config.profiles.filter((x) => x.id !== p.id);
        if (config.default_profile === p.id) config.default_profile = LOCAL;
        save();
        render();
      });
      head.append(del);
    }
    wrap.append(head);
    if (!isOpen) return wrap;

    const body = el("div", "profile-body");
    const changed = (key) => (v) => { p[key] = v; save(); title.textContent = profileName(p); detail.textContent = profileDetail(p); };
    const nameInput = input(p.name, p.id === LOCAL ? t("profile.local") : "", changed("name"), { mono: false });
    body.append(field(t("profile.name"), nameInput));
    if (p.kind === "shell") body.append(field(t("profile.shell"), input(p.command, t("profile.shellPlaceholder"), changed("command"), { list: "profile-shells" })));
    if (p.kind === "command") body.append(field(t("profile.command"), input(p.command, "docker exec -it web bash", changed("command"))));
    if (p.kind === "ssh") body.append(field(t("profile.host"), input(p.ssh_host, "my-server", changed("ssh_host"), { list: "profile-hosts" }), t("profile.hostDesc")));
    body.append(field(t("profile.args"), input(p.args, p.kind === "ssh" ? "-p 2222" : "", changed("args")), p.kind === "ssh" ? t("profile.argsSshDesc") : null));
    body.append(field(t("profile.cwd"), input(p.cwd, p.kind === "ssh" ? "" : t("profile.cwdPlaceholder"), changed("cwd")), p.kind === "ssh" ? t("profile.cwdSshDesc") : null));
    const env = el("textarea", "mono");
    env.rows = 3;
    env.spellcheck = false;
    env.placeholder = "KEY=value";
    env.value = envToText(p.env);
    env.addEventListener("input", () => { p.env = textToEnv(env.value); save(); });
    body.append(field(t("profile.env"), env, t("profile.envDesc")));
    wrap.append(body);
    return wrap;
  };

  render();
}
