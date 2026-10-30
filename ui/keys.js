// Keyboard shortcuts, per platform.
//
// macOS uses ⌘ like any Mac app. Elsewhere Ctrl+<key> belongs to the program running in the
// terminal (Ctrl+C, Ctrl+D, readline…), so app shortcuts use Ctrl+Shift, the convention of
// GNOME Terminal, Ghostty and Kitty on Linux. Letters match the typed character, so they follow
// non-QWERTY layouts; everything else matches the physical key.

export const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || "");

// id: [macCombo, otherCombo]. A null combo means the platform handles it natively.
const BINDINGS = {
  newTab: ["Meta+KeyT", "Ctrl+Shift+KeyT"],
  profileMenu: ["Meta+Shift+KeyT", "Ctrl+Shift+Alt+KeyT"],
  closePane: ["Meta+KeyW", "Ctrl+Shift+KeyW"],
  closeTab: ["Meta+Shift+KeyW", "Ctrl+Shift+Alt+KeyW"],
  splitRight: ["Meta+KeyD", "Ctrl+Shift+KeyD"],
  splitDown: ["Meta+Shift+KeyD", "Ctrl+Shift+Alt+KeyD"],
  prevPane: ["Meta+BracketLeft", "Ctrl+Shift+BracketLeft"],
  nextPane: ["Meta+BracketRight", "Ctrl+Shift+BracketRight"],
  prevTab: ["Meta+Shift+BracketLeft", "Ctrl+PageUp"],
  nextTab: ["Meta+Shift+BracketRight", "Ctrl+PageDown"],
  paneLeft: ["Meta+Alt+ArrowLeft", "Ctrl+Shift+Alt+ArrowLeft"],
  paneRight: ["Meta+Alt+ArrowRight", "Ctrl+Shift+Alt+ArrowRight"],
  paneUp: ["Meta+Alt+ArrowUp", "Ctrl+Shift+Alt+ArrowUp"],
  paneDown: ["Meta+Alt+ArrowDown", "Ctrl+Shift+Alt+ArrowDown"],
  sidebar: ["Meta+KeyI", "Ctrl+Shift+KeyI"],
  focusPrompt: ["Meta+KeyL", "Ctrl+Shift+KeyL"],
  history: ["Meta+KeyY", "Ctrl+Shift+KeyY"],
  clear: ["Meta+KeyK", "Ctrl+Shift+KeyK"],
  fontUp: ["Meta+Equal", "Ctrl+Shift+Equal"],
  fontDown: ["Meta+Minus", "Ctrl+Shift+Minus"],
  fontReset: ["Meta+Digit0", "Ctrl+Shift+Digit0"],
  settings: ["Meta+Comma", "Ctrl+Comma"],
  allow: ["Meta+Enter", "Ctrl+Enter"],
  copy: [null, "Ctrl+Shift+KeyC"], // ⌘C / ⌘V come from the native Edit menu on macOS
  paste: [null, "Ctrl+Shift+KeyV"],
  ...Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [`tab${n}`, [`Meta+Digit${n}`, `Alt+Digit${n}`]])),
};

// Extra combos that trigger an action but aren't shown (⌘+ needs Shift on a US keyboard).
const ALIASES = [
  ["fontUp", "Meta+Shift+Equal", null],
  ["fontUp", "Meta+NumpadAdd", "Ctrl+Shift+NumpadAdd"],
  ["fontDown", "Meta+NumpadSubtract", "Ctrl+Shift+NumpadSubtract"],
];

// Shown in tooltips and Settings, but typed into a text box, never matched globally.
const DISPLAY_ONLY = {
  send: ["Enter", "Enter"],
  newline: ["Shift+Enter", "Shift+Enter"],
};

function parse(combo) {
  const tokens = combo.split("+");
  const code = tokens.pop();
  return { code, meta: tokens.includes("Meta"), ctrl: tokens.includes("Ctrl"), shift: tokens.includes("Shift"), alt: tokens.includes("Alt") };
}

const column = IS_MAC ? 0 : 1;
const table = [];
for (const [id, combos] of Object.entries(BINDINGS)) if (combos[column]) table.push({ id, ...parse(combos[column]) });
for (const [id, ...combos] of ALIASES) if (combos[column]) table.push({ id, ...parse(combos[column]) });

function keyMatches(spec, e) {
  const letter = /^Key([A-Z])$/.exec(spec);
  if (letter && e.key.length === 1 && /[a-z]/i.test(e.key)) return e.key.toLowerCase() === letter[1].toLowerCase();
  return e.code === spec;
}

/** The shortcut id a keydown event triggers, or null. */
export function matchShortcut(e) {
  if (e.isComposing) return null;
  for (const b of table) {
    if (e.metaKey === b.meta && e.ctrlKey === b.ctrl && e.shiftKey === b.shift && e.altKey === b.alt && keyMatches(b.code, e)) return b.id;
  }
  return null;
}

const KEY_NAMES = { BracketLeft: "[", BracketRight: "]", Equal: "=", Minus: "-", Comma: ",", Enter: IS_MAC ? "↵" : "Enter",
  ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓", PageUp: "PgUp", PageDown: "PgDn" };
const MOD_NAMES = IS_MAC ? { Ctrl: "⌃", Alt: "⌥", Shift: "⇧", Meta: "⌘" } : { Ctrl: "Ctrl", Alt: "Alt", Shift: "Shift", Meta: "Meta" };

/** Display parts, e.g. ["⇧", "⌘", "W"] on macOS or ["Ctrl", "Shift", "W"] elsewhere. */
export function shortcutParts(id) {
  const combo = (BINDINGS[id] ?? DISPLAY_ONLY[id])?.[column];
  if (!combo) return [];
  const b = parse(combo);
  const key = KEY_NAMES[b.code] ?? b.code.replace(/^Key|^Digit/, "");
  // Apple's order is ⌃ ⌥ ⇧ ⌘; other platforms read Ctrl+Shift+Alt+key.
  const mods = IS_MAC
    ? [b.ctrl && "Ctrl", b.alt && "Alt", b.shift && "Shift", b.meta && "Meta"]
    : [b.meta && "Meta", b.ctrl && "Ctrl", b.shift && "Shift", b.alt && "Alt"];
  return [...mods.filter(Boolean).map((m) => MOD_NAMES[m]), key];
}

/** One-line label for tooltips: "⇧⌘W" or "Ctrl+Shift+Alt+W". */
export function shortcutLabel(id) {
  const parts = shortcutParts(id);
  return IS_MAC ? parts.join("") : parts.join("+");
}

/** Modifier part list of a shortcut with its last key replaced, e.g. ["⌘", "1…9"]. */
export function shortcutRange(id, keyText) {
  const parts = shortcutParts(id);
  return [...parts.slice(0, -1), keyText];
}
