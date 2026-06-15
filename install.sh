#!/usr/bin/env bash
# md installer — downloads a prebuilt binary from GitHub Releases.
#   curl -fsSL https://raw.githubusercontent.com/notshekhar/markdown/main/install.sh | bash
#
# Layout after install:
#   $MD_HOME/                 (default: ~/.md-bin)
#     ├── markdown            (standalone binary; no node/bun needed)
#     └── package.json        (version metadata)
#   $BIN_DIR/markdown → $MD_HOME/markdown   (symlink on PATH)
#   $BIN_DIR/md       → $MD_HOME/markdown   (alias; may be shadowed by a
#                                            shell alias for `md`)
#
# Env knobs:
#   MD_REPO_SLUG   notshekhar/markdown   override repo
#   MD_VERSION     vX.Y.Z                pin a tag
#   MD_HOME        $HOME/.md-bin         install dir
#   MD_BIN_DIR                           symlink dir (auto-detected)
#   MD_FORCE       1                     skip "already up to date" gate
#   MD_UNINSTALL   1                     remove install + symlink and exit

set -euo pipefail

REPO_SLUG="${MD_REPO_SLUG:-notshekhar/markdown}"
MD_HOME="${MD_HOME:-$HOME/.md-bin}"
FORCE="${MD_FORCE:-0}"
UNINSTALL="${MD_UNINSTALL:-0}"
PIN_VERSION="${MD_VERSION:-}"

bold() { printf "\033[1m%s\033[0m\n" "$*"; }
dim()  { printf "\033[2m%s\033[0m\n" "$*"; }
err()  { printf "\033[31m%s\033[0m\n" "$*" >&2; }

need_tool() {
  command -v "$1" >/dev/null 2>&1 || { err "Missing required tool: $1"; exit 1; }
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'
  else err "missing sha256sum/shasum"; return 1; fi
}

ver_gt() {
  local a="${1#v}" b="${2#v}"
  [ "$a" = "$b" ] && return 1
  [ "$(printf '%s\n%s\n' "$a" "$b" | sort -V | head -n1)" = "$b" ]
}

detect_target() {
  local os arch
  case "$(uname -s)" in
    Darwin) os="darwin" ;;
    Linux)  os="linux" ;;
    MINGW*|MSYS*|CYGWIN*) err "Windows: download the binary from the Releases page."; exit 1 ;;
    *) err "unsupported OS: $(uname -s)"; exit 1 ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64)  arch="x64" ;;
    arm64|aarch64) arch="arm64" ;;
    *) err "unsupported arch: $(uname -m)"; exit 1 ;;
  esac
  printf "%s-%s" "$os" "$arch"
}

resolve_latest_tag() {
  local final tag
  final="$(curl -fsSLI -o /dev/null -w '%{url_effective}' \
    "https://github.com/${REPO_SLUG}/releases/latest" 2>/dev/null || true)"
  tag="${final##*/}"
  case "$tag" in v[0-9]*) printf "%s" "$tag" ;; esac
}

resolve_bin_dir() {
  if [ -n "${MD_BIN_DIR:-}" ]; then mkdir -p "$MD_BIN_DIR"; printf "%s" "$MD_BIN_DIR"; return; fi
  for d in /usr/local/bin /opt/homebrew/bin; do
    [ -w "$d" ] 2>/dev/null && { printf "%s" "$d"; return; }
  done
  local fallback="$HOME/.local/bin"; mkdir -p "$fallback"; printf "%s" "$fallback"
}

uninstall() {
  bold "▶ Uninstalling markdown"
  for link in "$HOME/.local/bin/markdown" "/usr/local/bin/markdown" "/opt/homebrew/bin/markdown" \
              "$HOME/.local/bin/md" "/usr/local/bin/md" "/opt/homebrew/bin/md" \
              "${MD_BIN_DIR:+$MD_BIN_DIR/markdown}" "${MD_BIN_DIR:+$MD_BIN_DIR/md}"; do
    [ -n "$link" ] || continue
    { [ -L "$link" ] || [ -f "$link" ]; } && rm -f "$link" 2>/dev/null && dim "  removed $link" || true
  done
  rm -rf "$MD_HOME" 2>/dev/null && dim "  removed $MD_HOME" || true
  bold "✓ Uninstalled."
}

main() {
  [ "$UNINSTALL" = "1" ] && { uninstall; exit 0; }

  bold "▶ md installer"
  need_tool curl; need_tool tar

  local target latest installed
  target="$(detect_target)"
  dim "  target: $target"

  latest="${PIN_VERSION:-$(resolve_latest_tag)}"
  if [ -z "$latest" ]; then
    err "could not resolve latest release tag from $REPO_SLUG"
    err "set MD_VERSION=vX.Y.Z to pin a release"
    exit 1
  fi
  case "$latest" in v*) ;; *) latest="v$latest" ;; esac

  installed=""
  [ -f "$MD_HOME/package.json" ] && \
    installed="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$MD_HOME/package.json" | head -n1 || true)"
  if [ "$FORCE" != "1" ] && [ -n "$installed" ] && ! ver_gt "${latest#v}" "${installed#v}"; then
    bold "✓ Up to date (installed $installed, latest $latest)"
    dim "  MD_FORCE=1 to reinstall"
    exit 0
  fi

  local scratch tar url base
  scratch="${MD_HOME}.new.$$"
  trap 'rm -rf "$scratch" 2>/dev/null || true' EXIT
  mkdir -p "$scratch"

  base="https://github.com/${REPO_SLUG}/releases/download/${latest}"
  url="${base}/md-${target}.tar.gz"
  tar="$scratch/md.tar.gz"

  bold "▶ Downloading ${url##*/}"
  curl -fL --progress-bar "$url" -o "$tar" || { err "download failed: $url"; exit 1; }

  if curl -fsSL "${url}.sha256" -o "$scratch/sum" 2>/dev/null && [ -s "$scratch/sum" ]; then
    local expected got
    expected="$(awk '{print $1}' "$scratch/sum")"
    got="$(sha256_of "$tar")"
    [ "$expected" = "$got" ] || { err "sha256 mismatch"; exit 1; }
    dim "  sha256 ok"
  fi

  bold "▶ Extracting"
  tar -xzf "$tar" -C "$scratch"
  [ -x "$scratch/$target/markdown" ] || { err "tarball missing $target/markdown"; exit 1; }

  if [ "$(uname -s)" = "Darwin" ] && command -v xattr >/dev/null 2>&1; then
    xattr -dr com.apple.quarantine "$scratch/$target" 2>/dev/null || true
  fi

  bold "▶ Installing to $MD_HOME"
  [ -e "$MD_HOME" ] && rm -rf "${MD_HOME}.old.$$" && mv "$MD_HOME" "${MD_HOME}.old.$$"
  mv "$scratch/$target" "$MD_HOME"
  rm -rf "${MD_HOME}.old.$$" 2>/dev/null || true
  trap - EXIT
  rm -rf "$scratch" 2>/dev/null || true

  local bin_dir; bin_dir="$(resolve_bin_dir)"
  ln -sf "$MD_HOME/markdown" "$bin_dir/markdown"
  ln -sf "$MD_HOME/markdown" "$bin_dir/md"
  hash -r 2>/dev/null || true

  case ":$PATH:" in
    *":$bin_dir:"*) ;;
    *) err "warning: $bin_dir is not on PATH — add it to your shell rc" ;;
  esac

  "$MD_HOME/markdown" --version >/dev/null 2>&1 || { err "installed binary failed to run"; exit 1; }
  bold "✓ Installed markdown $latest → $bin_dir/markdown"
  if alias md >/dev/null 2>&1 || type md 2>/dev/null | grep -qiv "$bin_dir/md"; then
    dim "  note: \`md\` is shadowed by a shell alias on this machine — use \`markdown\`."
  fi
}

main "$@"
