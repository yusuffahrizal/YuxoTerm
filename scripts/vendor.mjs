// Copies the xterm.js runtime files into ui/vendor so the UI needs no bundler.
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "ui", "vendor");
mkdirSync(out, { recursive: true });

const files = [
  ["@xterm/xterm/lib/xterm.js", "xterm.js"],
  ["@xterm/xterm/css/xterm.css", "xterm.css"],
  ["@xterm/addon-fit/lib/addon-fit.js", "addon-fit.js"],
  ["@xterm/addon-web-links/lib/addon-web-links.js", "addon-web-links.js"],
  ["@xterm/addon-webgl/lib/addon-webgl.js", "addon-webgl.js"],
];
for (const [src, dst] of files) {
  copyFileSync(join(root, "node_modules", src), join(out, dst));
}
console.log(`vendored ${files.length} files into ui/vendor`);
