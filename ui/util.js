// Small DOM and IPC helpers shared by the UI modules.

export const { invoke } = window.__TAURI__.core;

export const $ = (sel, root = document) => root.querySelector(sel);

export const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export const basename = (p) => (p ? p.replace(/\/+$/, "").split("/").pop() || "/" : "");
