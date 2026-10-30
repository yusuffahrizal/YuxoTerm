#!/usr/bin/env bash
# Builds YuxoTerm as a .deb for Debian, Ubuntu and their derivatives (Mint, Pop!_OS, Kali…).
#
#   scripts/build-linux.sh                    build the .deb; fails with a list of what is missing
#   scripts/build-linux.sh --install-deps     also install build packages (apt) and Rust (rustup)
#   scripts/build-linux.sh --deps-only        only install the build packages (used by CI)
#
# Needs Debian 12 / Ubuntu 22.04 or newer: Tauri 2 requires WebKitGTK 4.1.
# Node.js 18+ must already be installed; the script says how if it isn't.
set -euo pipefail

BUNDLES="deb"
INSTALL_DEPS=0
DEPS_ONLY=0

usage() { sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --install-deps) INSTALL_DEPS=1 ;;
    --deps-only) INSTALL_DEPS=1; DEPS_ONLY=1 ;;
    --bundles) BUNDLES="${2:?--bundles needs a value, e.g. deb}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

die() { echo "error: $*" >&2; exit 1; }
step() { printf '\n==> %s\n' "$*"; }

[ "$(uname -s)" = "Linux" ] || die "this script is for Linux; use 'npm run build' on macOS."
command -v apt-get >/dev/null || die "apt-get not found; this script supports Debian, Ubuntu and derivatives."

# Debian-family check: ID or ID_LIKE mentions debian or ubuntu.
. /etc/os-release
case " ${ID:-} ${ID_LIKE:-} " in
  *" debian "*|*" ubuntu "*) ;;
  *) die "${PRETTY_NAME:-this system} is not Debian-based." ;;
esac

if [ "$(id -u)" -eq 0 ]; then SUDO=""; else
  command -v sudo >/dev/null || die "run as root or install sudo (needed for apt)."
  SUDO="sudo"
fi

PACKAGES=(
  build-essential ca-certificates curl wget file pkg-config
  libssl-dev libwebkit2gtk-4.1-dev libgtk-3-dev libxdo-dev
  libayatana-appindicator3-dev librsvg2-dev
)

missing_packages() {
  local p
  for p in "${PACKAGES[@]}"; do
    dpkg -s "$p" >/dev/null 2>&1 || echo "$p"
  done
}

if [ "$INSTALL_DEPS" -eq 1 ]; then
  step "Installing build packages"
  $SUDO apt-get update
  if ! apt-cache show libwebkit2gtk-4.1-dev >/dev/null 2>&1; then
    die "libwebkit2gtk-4.1-dev is not available on ${PRETTY_NAME:-this system}; Debian 12 / Ubuntu 22.04 or newer is required."
  fi
  $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${PACKAGES[@]}"
else
  missing="$(missing_packages | tr '\n' ' ')"
  if [ -n "$missing" ]; then
    die "missing packages: $missing
Install them with:  scripts/build-linux.sh --install-deps"
  fi
fi

[ "$DEPS_ONLY" -eq 1 ] && { echo "Build packages are installed."; exit 0; }

step "Checking Node.js"
if ! command -v node >/dev/null; then
  die "Node.js 18 or newer is required. Install it from https://nodejs.org or with nvm (https://github.com/nvm-sh/nvm); the apt version is usually too old."
fi
node_major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$node_major" -ge 18 ] || die "Node.js $(node -v) is too old; 18 or newer is required."
echo "node $(node -v)"

step "Checking Rust"
export PATH="$HOME/.cargo/bin:$PATH"
if ! command -v cargo >/dev/null; then
  [ "$INSTALL_DEPS" -eq 1 ] || die "Rust is not installed. Install it from https://rustup.rs, or rerun with --install-deps."
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
fi
echo "$(rustc --version)"

cd "$(dirname "$0")/.."

step "Installing npm dependencies"
npm ci

step "Building (bundles: $BUNDLES)"
npm run build -- --bundles "$BUNDLES"

step "Done"
find src-tauri/target/release/bundle -type f \( -name '*.deb' -o -name '*.rpm' -o -name '*.AppImage' \) -print
echo
echo "Install the .deb with:  sudo apt install ./<file>.deb"
