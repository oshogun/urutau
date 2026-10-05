#!/usr/bin/env bash
# Installs, upgrades or removes Urutau on Linux for the current user.
#
#   curl -fsSL https://raw.githubusercontent.com/oshogun/urutau/main/packaging/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/oshogun/urutau/main/packaging/install.sh | bash -s -- --public-url http://192.168.1.20:8787
#
# Every option also has a URUTAU_* environment variable, which is the other way to pass
# one through `curl | bash` (see --help). No sudo is used: a private Node 24 and the app
# live under the install directory, and the service (a systemd --user unit) runs as the
# current user. Running the script again upgrades; --uninstall removes the service and the
# app and keeps the configuration and the data.
#
# All code is in functions and the last line is `main "$@"`. Under `curl | bash` bash reads
# the script from stdin, so it must read the whole script before running any of it, and no
# child process may read the rest of the script: main moves its own stdin to /dev/null.
# This script never runs under `set -x`: it handles TOKEN_ENCRYPTION_KEY.

RELEASE_BASE_URL_DEFAULT="https://github.com/oshogun/urutau/releases/download"
API_URL_DEFAULT="https://api.github.com/repos/oshogun/urutau/releases/latest"
NODE_DIST_URL_DEFAULT="https://nodejs.org/dist"
LATEST_RELEASE_PAGE="https://github.com/oshogun/urutau/releases/latest"
UNINSTALL_URL="https://raw.githubusercontent.com/oshogun/urutau/main/packaging/install.sh"
DEFAULT_PORT=8787
# Releases published before the installers existed: they have no bundle.
NO_BUNDLE_VERSIONS="0.1.0 0.2.0 0.3.0 0.4.0 0.5.0"
# The server's variables, from README "Environment variables", plus NODE_OPTIONS. They are
# removed from every process this script starts (the file's values would lose to them) and
# from the service by UnsetEnvironment=.
SERVER_VARS="HOST PORT DATABASE_URL PUBLIC_URL ALLOWED_HOSTS TRUST_PROXY TOKEN_ENCRYPTION_KEY KEYCLOAK_ISSUER KEYCLOAK_CLIENT_ID KEYCLOAK_CLIENT_SECRET KEYCLOAK_GITHUB_IDP KEYCLOAK_BROKER_API KEYCLOAK_ALLOW_HTTP NODE_OPTIONS"

TRIAL_PID=""
ROOT=""
LOCK_HELD=0

log() { printf 'urutau-install: %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
# Prints text exactly as given (the user-visible messages), without the prefix.
say() { printf '%s\n' "$*"; }

# Runs on every way the script ends: stops a trial server this run started and releases
# the lock, so a run that ends with an error never blocks the next one.
on_exit() {
  if [ -n "$TRIAL_PID" ]; then
    kill -TERM "$TRIAL_PID" 2>/dev/null || true
  fi
  if [ "$LOCK_HELD" = 1 ] && [ -n "$ROOT" ]; then
    rmdir "$ROOT/.install.lock" 2>/dev/null || true
  fi
}

usage() {
  cat <<'USAGE'
Usage: install.sh [options]

  --version X.Y.Z          install this release instead of the latest (a leading v is accepted)
  --bundle PATH_OR_URL     install from this bundle; no release lookup
  --install-dir DIR        install root (default: ${XDG_DATA_HOME:-$HOME/.local/share}/urutau)
  --port N                 PORT, 1024-65535 (default 8787, or the existing value)
  --public-url URL         open Urutau to other computers at this address: sets PUBLIC_URL
                           and HOST=0.0.0.0 (unless --bind-host is given); skips the question
  --local                  this computer only: HOST=127.0.0.1 and no PUBLIC_URL; skips the question
  --bind-host ADDR         HOST itself, for one interface or a proxy on this machine
  --allowed-hosts a,b      ALLOWED_HOSTS
  --no-service             register no service; check the install with a trial start
  --force                  replace the app even when that version is installed
  --uninstall              remove the service and the app; keep the configuration and the data
  --purge                  with --uninstall: delete the whole install directory
  --yes                    ask nothing: the address defaults to this computer only,
                           and purge needs no typed confirmation
  --no-linger              do not enable linger (the service then starts at login, not at boot)
  --help                   print this text and exit

Each option has an environment variable: URUTAU_VERSION, URUTAU_BUNDLE, URUTAU_INSTALL_DIR,
URUTAU_PORT, URUTAU_PUBLIC_URL, URUTAU_LOCAL=1, URUTAU_BIND_HOST, URUTAU_ALLOWED_HOSTS,
URUTAU_NO_SERVICE=1, URUTAU_FORCE=1, URUTAU_UNINSTALL=1, URUTAU_PURGE=1, URUTAU_YES=1,
URUTAU_NO_LINGER=1. A flag wins over its variable.
USAGE
}

# ---- helpers ------------------------------------------------------------------------

# Runs a command without the server's variables.
run_node() {
  local args=() v
  for v in $SERVER_VARS; do args+=(-u "$v"); done
  env "${args[@]}" "$@"
}

sha256_of() { sha256sum "$1" | awk '{print $1}'; }

require_cmd() {
  local c
  for c in "$@"; do
    command -v "$c" >/dev/null 2>&1 || die "required command not found: $c"
  done
}

now_utc() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# True when a terminal can be opened. Not `[ -t 0 ]` (stdin is the script under
# `curl | bash`) and not `[ -r /dev/tty ]` (true even with no terminal, for example under
# setsid): opening it is the real test.
have_tty() { { : < /dev/tty; } 2>/dev/null; }

trim() {
  local s="$1"
  s="${s#"${s%%[![:space:]]*}"}"
  s="${s%"${s##*[![:space:]]}"}"
  printf '%s' "$s"
}

# Prints a configuration file's value for KEY: the last line that defines it, trimmed.
# Pure bash, so a secret never reaches another process.
env_get() {
  local file="$1" key="$2" line val=""
  [ -f "$file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    if [[ "$line" =~ ^[[:space:]]*"$key"[[:space:]]*=(.*)$ ]]; then
      val="${BASH_REMATCH[1]}"
      val="${val%$'\r'}"
    fi
  done < "$file"
  trim "$val"
}

# Sets KEY to VALUE: replaces the last line that defines KEY and deletes the earlier ones,
# or appends the line. No other line changes.
env_set() {
  local file="$1" key="$2" value="$3" line i last=-1
  local lines=() out=()
  if [ -f "$file" ]; then
    while IFS= read -r line || [ -n "$line" ]; do lines+=("$line"); done < "$file"
  fi
  for i in "${!lines[@]}"; do
    if [[ "${lines[$i]}" =~ ^[[:space:]]*"$key"[[:space:]]*= ]]; then last="$i"; fi
  done
  for i in "${!lines[@]}"; do
    if [[ "${lines[$i]}" =~ ^[[:space:]]*"$key"[[:space:]]*= ]]; then
      [ "$i" = "$last" ] && out+=("$key=$value")
    else
      out+=("${lines[$i]}")
    fi
  done
  [ "$last" != -1 ] || out+=("$key=$value")
  printf '%s\n' "${out[@]}" > "$file"
}

# Deletes every line that defines KEY.
env_remove() {
  local file="$1" key="$2" line out=()
  [ -f "$file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    [[ "$line" =~ ^[[:space:]]*"$key"[[:space:]]*= ]] || out+=("$line")
  done < "$file"
  if [ "${#out[@]}" -gt 0 ]; then printf '%s\n' "${out[@]}" > "$file"; else : > "$file"; fi
}

# A value written to the configuration: no space, #, quote, CR or LF, because
# Node's --env-file parser would cut the value at a # and keep quotes as part of it.
check_plain_value() {
  local what="$1" value="$2"
  # shellcheck disable=SC1003 # the quote characters below are literal patterns
  case "$value" in
    *[[:space:]]*|*'#'*|*'"'*|*"'"*|*'`'*) die "$what must not contain spaces, # or quotes: $value" ;;
  esac
}

# ---- the address question -----------------------------------------

reason_text() {
  case "$1" in
    1) printf 'it must start with http:// or https://' ;;
    2) printf 'it must not contain spaces, a user name (@), a query (?) or a fragment (#)' ;;
    3) printf 'it has no host name' ;;
    4) printf 'an IPv6 address must be in brackets, for example http://[fe80::1]:%s' "$2" ;;
    5) printf 'its port must be a number from 1 to 65535' ;;
  esac
}

# parse_address ANSWER PORT MODE. MODE "ask" is the typed answer (steps 1 to 11); MODE
# "flag" is a --public-url value (steps 1 and 4 to 8: no scheme added, no loopback
# conversion). Sets PA_KIND (local or url or reject), PA_URL and PA_REASON (1 to 5).
parse_address() {
  local a="$1" port="$2" mode="$3" scheme_added=0 scheme rest authority path host after p="" haveport=0 colons lc
  PA_KIND=""; PA_URL=""; PA_REASON=0
  a="$(trim "$a")"
  if [ -z "$a" ]; then
    if [ "$mode" = ask ]; then PA_KIND=local; else PA_KIND=reject; PA_REASON=1; fi
    return 0
  fi
  if [ "$mode" = ask ] && [[ "$a" != *"://"* ]]; then a="http://$a"; scheme_added=1; fi
  case "$a" in
    http://*|https://*) ;;
    *) PA_KIND=reject; PA_REASON=1; return 0 ;;
  esac
  if [[ "$a" =~ [[:space:]@?#] ]]; then PA_KIND=reject; PA_REASON=2; return 0; fi
  scheme="${a%%://*}"
  rest="${a#*://}"
  authority="${rest%%/*}"
  path=""
  if [[ "$rest" == */* ]]; then path="/${rest#*/}"; fi
  if [[ "$authority" == \[* ]]; then
    if [[ "$authority" != *"]"* ]]; then PA_KIND=reject; PA_REASON=3; return 0; fi
    host="${authority%%]*}]"
    after="${authority#*]}"
    case "$after" in
      "") ;;
      :*) p="${after#:}"; haveport=1 ;;
      *) PA_KIND=reject; PA_REASON=3; return 0 ;;
    esac
  else
    colons="${authority//[^:]/}"
    if [ "${#colons}" -gt 1 ]; then PA_KIND=reject; PA_REASON=4; return 0; fi
    host="${authority%%:*}"
    if [[ "$authority" == *:* ]]; then p="${authority#*:}"; haveport=1; fi
  fi
  if [ -z "$host" ] || [ "$host" = "[]" ]; then PA_KIND=reject; PA_REASON=3; return 0; fi
  if [ "$haveport" = 1 ]; then
    if ! [[ "$p" =~ ^[0-9]+$ ]] || [ "${#p}" -gt 5 ] || [ "$((10#$p))" -lt 1 ] || [ "$((10#$p))" -gt 65535 ]; then
      PA_KIND=reject; PA_REASON=5; return 0
    fi
  fi
  while [[ "$path" == */ ]]; do path="${path%/}"; done
  if [ "$scheme_added" = 1 ] && [ "$haveport" = 0 ]; then authority="$authority:$port"; fi
  if [ "$mode" = ask ]; then
    lc="${host,,}"
    case "$lc" in
      localhost|127.*|"[::1]") PA_KIND=local; return 0 ;;
    esac
  fi
  PA_KIND=url
  PA_URL="$scheme://$authority$path"
}

first_ipv4() {
  local ip
  ip="$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -v '^127\.' | grep -E '^[0-9.]+$' | head -n1 || true)"
  printf '%s' "${ip:-192.168.1.20}"
}

# Asks the address question on the terminal (Q1 to Q3). Sets WANT_PUBLIC_URL (empty for
# this computer only) and WANT_HOST.
ask_address() {
  local port="$1" ip tries=0 answer
  ip="$(first_ipv4)"
  {
    say "Which address will people open to use Urutau?"
    say ""
    say "  Press Enter to use it on this computer only, at http://127.0.0.1:$port."
    say ""
    say "  To use it from other computers too, type the address they will open,"
    say "  for example http://$ip:$port or http://urutau.lan:$port."
    say "  Urutau then listens on every network interface of this computer."
    say ""
    say "  The first person to open a new Urutau creates its admin account."
    say ""
  } > /dev/tty
  while [ "$tries" -lt 3 ]; do
    printf 'Address (Enter for this computer only): ' > /dev/tty
    answer=""
    read -r answer < /dev/tty || true
    parse_address "$answer" "$port" ask
    case "$PA_KIND" in
      local) WANT_PUBLIC_URL=""; WANT_HOST=127.0.0.1; return 0 ;;
      url) WANT_PUBLIC_URL="$PA_URL"; WANT_HOST=0.0.0.0; return 0 ;;
    esac
    say "That is not an address Urutau can use: $(reason_text "$PA_REASON" "$port")." > /dev/tty
    tries=$((tries + 1))
  done
  die "no usable address after 3 tries. Nothing was changed. Re-run the installer, or pass --public-url <address>."
}

# Q5: a public URL whose explicit port is not the one Urutau listens on.
warn_url_port() {
  local url="$1" port="$2" auth urlport
  [[ "$url" == http://* ]] || return 0
  auth="${url#http://}"
  auth="${auth%%/*}"
  urlport=""
  if [[ "$auth" == \[* ]]; then
    case "${auth#*]}" in :*) urlport="${auth#*]:}" ;; esac
  elif [[ "$auth" == *:* ]]; then
    urlport="${auth#*:}"
  fi
  [ -n "$urlport" ] && [ "$urlport" != "$port" ] || return 0
  warn "$url names port $urlport, but Urutau listens on port $port. That is right only behind a reverse proxy that forwards $urlport to $port; otherwise re-run with --port $urlport."
}

# ---- platform and root ---------------------------------------------------------------

check_platform() {
  local m
  if [ "$(id -u)" = 0 ] && [ -n "${SUDO_USER:-}" ]; then
    die "run this as the user who will own Urutau, without sudo."
  fi
  case "$(uname -s)" in
    Linux) ;;
    Darwin) die "macOS is not supported by the installer. Use the Docker image: ghcr.io/oshogun/urutau" ;;
    *) die "unsupported operating system: $(uname -s). Use install.ps1 on Windows." ;;
  esac
  m="$(uname -m)"
  case "$m" in
    x86_64) ARCH=x64 ;;
    aarch64|arm64) ARCH=arm64 ;;
    *) die "unsupported architecture: $m. The installer supports x64 and arm64." ;;
  esac
  if [ -e /lib/ld-musl-x86_64.so.1 ] || [ -e /lib/ld-musl-aarch64.so.1 ] \
     || { command -v ldd >/dev/null 2>&1 && ldd --version 2>&1 | grep -qi musl; }; then
    die "musl-based Linux (for example Alpine) is not supported by the installer. Use the Docker image: ghcr.io/oshogun/urutau"
  fi
}

validate_root() {
  case "$ROOT" in
    /*) ;;
    *) die "the install directory must be an absolute path: $ROOT" ;;
  esac
  # shellcheck disable=SC1003 # the quoted backslash is a literal one-character pattern
  case "$ROOT" in
    *'#'*|*'%'*|*'"'*|*"'"*|*'\'*|*'$'*|*'`'*|*$'\r'*|*$'\n'*)
      die "the install directory contains a character that is not allowed (one of # % \" ' \\ \$ \` or a CR or LF): $ROOT" ;;
  esac
  while [ "${#ROOT}" -gt 1 ] && [ "${ROOT%/}" != "$ROOT" ]; do ROOT="${ROOT%/}"; done
  if [ "$ROOT" = "/" ] || [ "$ROOT" = "$HOME" ]; then
    die "the install directory must not be / or your home directory: $ROOT"
  fi
}

# ---- marker -------------------------------------------------------------

read_marker() {
  local f="$ROOT/.urutau-install" layout
  M_VERSION=""; M_NODE=""; M_AUTOSTART=""; M_LINGER=0; M_STATE=""; M_INSTALLED_AT=""
  HAVE_MARKER=0
  [ -f "$f" ] || return 0
  HAVE_MARKER=1
  m_get() { grep "^$1=" "$f" | head -n1 | cut -d= -f2- || true; }
  layout="$(m_get layout)"
  if [ -n "$layout" ] && [ "$layout" -gt 1 ] 2>/dev/null; then
    die "this install was created by a newer installer; get a newer install.sh"
  fi
  M_VERSION="$(m_get version)"
  M_NODE="$(m_get node)"
  M_AUTOSTART="$(m_get autostart)"
  M_LINGER="$(m_get linger_enabled_by_installer)"
  M_STATE="$(m_get state)"
  M_INSTALLED_AT="$(m_get installed_at)"
  [ -n "$M_AUTOSTART" ] || M_AUTOSTART=none
  [ -n "$M_LINGER" ] || M_LINGER=0
}

# write_marker STATE VERSION NODE AUTOSTART LINGER
write_marker() {
  local now installed_at tmp="$ROOT/.urutau-install.tmp"
  now="$(now_utc)"
  installed_at="${M_INSTALLED_AT:-$now}"
  cat > "$tmp" <<MARKER
# Urutau install marker - written by the installer, do not edit.
layout=1
version=$2
node=$3
os=linux
arch=$ARCH
autostart=$4
linger_enabled_by_installer=$5
firewall_rule=0
state=$1
installed_at=$installed_at
updated_at=$now
MARKER
  mv "$tmp" "$ROOT/.urutau-install"
  M_INSTALLED_AT="$installed_at"
}

# ---- Node ----------------------------------------------------------------------------

# Stages the latest Node 24 in .staging/node when it differs from the installed one, after
# checking its SHA-256 against nodejs.org's SHASUMS256.txt. Sets NODE_DIR and NODE_REPLACED.
ensure_node() {
  local dist="${URUTAU_NODE_DIST_URL:-$NODE_DIST_URL_DEFAULT}" sums="$STAGING/dl/node-SHASUMS256.txt"
  local line hash file target current="" actual inner
  mkdir -p "$STAGING/dl"
  curl -fsSL --connect-timeout 15 --retry 3 -o "$sums" "$dist/latest-v24.x/SHASUMS256.txt" </dev/null \
    || die "could not download the Node 24 checksums from $dist/latest-v24.x/SHASUMS256.txt"
  line="$(grep -E "node-v24\.[0-9]+\.[0-9]+-linux-${ARCH}\.tar\.gz\$" "$sums" | head -n1 || true)"
  [ -n "$line" ] || die "could not find a Node 24 build for linux-$ARCH in $dist/latest-v24.x/SHASUMS256.txt"
  hash="$(printf '%s' "$line" | awk '{print $1}')"
  file="$(printf '%s' "$line" | awk '{print $2}')"
  target="$(printf '%s' "$file" | sed -E 's/^node-v(24\.[0-9]+\.[0-9]+)-.*/\1/')"
  if [ -x "$ROOT/node/bin/node" ]; then
    current="$(run_node "$ROOT/node/bin/node" --version 2>/dev/null </dev/null | sed 's/^v//' || true)"
  fi
  NODE_VERSION="$target"
  if [ "$current" = "$target" ]; then
    NODE_REPLACED=0
    NODE_DIR="$ROOT/node"
    return 0
  fi
  log "Downloading Node $target for linux-$ARCH"
  curl -fsSL --connect-timeout 15 --retry 3 -o "$STAGING/dl/$file" "$dist/v$target/$file" </dev/null \
    || die "could not download Node: $dist/v$target/$file"
  actual="$(sha256_of "$STAGING/dl/$file")"
  [ "$actual" = "$hash" ] || die "checksum mismatch for $file. Nothing was changed."
  rm -rf "$STAGING/node-extract" "$STAGING/node"
  mkdir -p "$STAGING/node-extract"
  tar -xzf "$STAGING/dl/$file" -C "$STAGING/node-extract" </dev/null
  inner="$(find "$STAGING/node-extract" -mindepth 1 -maxdepth 1 -type d | head -n1)"
  [ -n "$inner" ] || die "unexpected layout in $file"
  mv "$inner" "$STAGING/node"
  rm -rf "$STAGING/node-extract" "$STAGING/dl/$file"
  NODE_REPLACED=1
  NODE_DIR="$STAGING/node"
}

# ---- version and bundle ---------------------------------------------

VERSION_RE='^[0-9]+\.[0-9]+\.[0-9]+(-(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(\.(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?$'

is_no_bundle_version() {
  local v
  for v in $NO_BUNDLE_VERSIONS; do [ "$v" = "$1" ] && return 0; done
  return 1
}

# Sets VERSION to the latest release: one GET to the GitHub REST API without credentials,
# then the redirect of github.com/.../releases/latest when that fails.
lookup_latest() {
  local api="${URUTAU_API_URL:-$API_URL_DEFAULT}" latest_file="$STAGING/latest.json" code tag="" redirect
  code="$(curl -sS --connect-timeout 15 --max-time 30 -o "$latest_file" -w '%{http_code}' \
    -H 'Accept: application/vnd.github+json' -H 'X-GitHub-Api-Version: 2022-11-28' -H 'User-Agent: urutau-install' \
    "$api" </dev/null 2>/dev/null || true)"
  if [ "$code" = 200 ]; then
    tag="$(run_node "$NODE_DIR/bin/node" -e '
      const fs = require("fs")
      let d
      try { d = JSON.parse(fs.readFileSync(process.argv[1], "utf8")) } catch (e) { process.exit(1) }
      if (typeof d.tag_name !== "string") process.exit(1)
      process.stdout.write(d.tag_name.replace(/^v/, ""))
    ' "$latest_file" </dev/null 2>/dev/null || true)"
  fi
  if ! [[ "$tag" =~ $VERSION_RE ]]; then
    tag=""
    redirect="$(curl -fsSLI --connect-timeout 15 --max-time 30 -o /dev/null -w '%{url_effective}' "$LATEST_RELEASE_PAGE" </dev/null 2>/dev/null || true)"
    case "$redirect" in
      */tag/v*) tag="${redirect##*/tag/v}" ;;
    esac
    [[ "$tag" =~ $VERSION_RE ]] || tag=""
  fi
  [ -n "$tag" ] || die "could not find the latest Urutau release (api.github.com and github.com did not answer). Pass --version X.Y.Z."
  VERSION="$tag"
  if is_no_bundle_version "$VERSION"; then
    die "the latest release, v$VERSION, has no installer bundle. Packaged releases start with the release after v0.5.0. Until it is published, use Docker (ghcr.io/oshogun/urutau:$VERSION) or a source checkout."
  fi
}

# Downloads URL to OUT. Prints the HTTP status; the return status is 0 only for 200.
download_status() {
  local code
  code="$(curl -sSL --connect-timeout 15 --retry 3 -o "$2" -w '%{http_code}' "$1" </dev/null 2>/dev/null || true)"
  DL_CODE="${code:-000}"
  [ "$DL_CODE" = 200 ]
}

# Compares the file with the first field of a .sha256 file, lower-cased.
verify_sha256() {
  local file="$1" shafile="$2" name="$3" expected actual
  expected="$(awk '{print tolower($1); exit}' "$shafile")"
  actual="$(sha256_of "$file")"
  [ "$expected" = "$actual" ] || die "checksum mismatch for $name. Nothing was changed."
}

# Gets the bundle (release download or --bundle), verifies it, extracts it to .staging/app.
fetch_bundle() {
  local base="${URUTAU_RELEASE_BASE_URL:-$RELEASE_BASE_URL_DEFAULT}" tarball="$STAGING/dl/bundle.tar.gz"
  local shafile="$STAGING/dl/bundle.tar.gz.sha256" url have_sha=0 count inner bundle_version engines shown
  mkdir -p "$STAGING/dl"
  if [ -n "$BUNDLE" ]; then
    case "$BUNDLE" in
      http://*|https://*)
        log "Downloading $BUNDLE"
        download_status "$BUNDLE" "$tarball" || die "could not download $BUNDLE (HTTP $DL_CODE)"
        if download_status "$BUNDLE.sha256" "$shafile"; then have_sha=1; fi
        [ "$have_sha" = 1 ] || warn "no checksum file at $BUNDLE.sha256; installing $BUNDLE unverified."
        ;;
      *)
        [ -f "$BUNDLE" ] || die "the bundle was not found: $BUNDLE"
        cp "$BUNDLE" "$tarball"
        if [ -f "$BUNDLE.sha256" ]; then
          cp "$BUNDLE.sha256" "$shafile"; have_sha=1
        else
          warn "no checksum file at $BUNDLE.sha256; installing $BUNDLE unverified."
        fi
        ;;
    esac
  else
    url="$base/v$VERSION/urutau-server-$VERSION.tar.gz"
    log "Downloading Urutau $VERSION"
    if ! download_status "$url" "$tarball"; then
      if [ "$DL_CODE" = 404 ]; then
        die "no installer bundle at $url (HTTP 404). Either v$VERSION is not a release, or it was published before the installers existed: packaged releases start with the first release whose assets include urutau-server-<version>.tar.gz. Releases: https://github.com/oshogun/urutau/releases"
      fi
      die "could not download $url (HTTP $DL_CODE)"
    fi
    download_status "$url.sha256" "$shafile" || die "no checksum file at $url.sha256 (HTTP $DL_CODE). Nothing was changed."
    have_sha=1
  fi
  if [ "$have_sha" = 1 ]; then
    if [ -n "$BUNDLE" ]; then shown="$(basename "$BUNDLE")"; else shown="urutau-server-$VERSION.tar.gz"; fi
    verify_sha256 "$tarball" "$shafile" "$shown"
  fi

  rm -rf "$STAGING/app" "$STAGING/extract"
  mkdir -p "$STAGING/extract"
  tar -xzf "$tarball" -C "$STAGING/extract" </dev/null || die "could not extract the bundle"
  count="$(find "$STAGING/extract" -mindepth 1 -maxdepth 1 | wc -l)"
  inner="$(find "$STAGING/extract" -mindepth 1 -maxdepth 1 -type d | head -n1)"
  { [ "$count" = 1 ] && [ -n "$inner" ]; } || die "unexpected bundle layout: it must hold one top-level directory"
  mv "$inner" "$STAGING/app"
  rm -rf "$STAGING/extract" "$STAGING/dl"
  local f
  for f in VERSION package.json package-lock.json server/main.ts dist/index.html; do
    [ -f "$STAGING/app/$f" ] || die "the bundle is missing $f"
  done
  bundle_version="$(tr -d '[:space:]' < "$STAGING/app/VERSION")"
  [[ "$bundle_version" =~ $VERSION_RE ]] || die "the bundle's VERSION is not a version: $bundle_version"
  if [ -n "$BUNDLE" ]; then
    VERSION="$bundle_version"
  elif [ "$bundle_version" != "$VERSION" ]; then
    die "the downloaded bundle reports version $bundle_version, expected $VERSION"
  fi
  if ! grep -qF '"node": ">=24 <25"' "$STAGING/app/package.json"; then
    engines="$(sed -n 's/.*"node": *"\([^"]*\)".*/\1/p' "$STAGING/app/package.json" | head -n1)"
    die "this release needs Node $engines, and this installer installs Node 24. Use the installer attached to that release: https://github.com/oshogun/urutau/releases/download/v$VERSION/install.sh"
  fi
}

npm_ci() {
  log "Installing the dependencies (npm ci --omit=dev)"
  if ! (
    cd "$STAGING/app" \
      && run_node PATH="$NODE_DIR/bin:$PATH" "$NODE_DIR/bin/npm" ci --omit=dev --no-audit --no-fund
  ) > "$STAGING/npm.log" 2>&1 </dev/null; then
    tail -n 20 "$STAGING/npm.log" >&2
    die "npm ci failed while installing the dependencies. Nothing was changed."
  fi
}

# ---- configuration -----------------------------------------------------

write_helpers() {
  cat > "$STAGING/check-config.mjs" <<'CHECK_CONFIG_EOF'
// Written by install.sh and install.ps1 into <root>/.staging/check-config.mjs and run as
//   <node> --env-file=<root>/.staging/urutau.env <root>/.staging/check-config.mjs <staged app dir>
// with every server variable removed from the environment first, so the only values it
// sees are the staged file's. It loads the staged app's own configuration reader and
// runs it, so the installer accepts exactly what the new server will accept. Exit 0: the
// file is valid. Exit 1: the first line of stderr is the reader's message, which names
// the variable and never its value. Prints nothing on success: the file holds a secret.
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const appDir = process.argv[2]
const { loadConfig } = await import(pathToFileURL(join(appDir, 'server', 'config.ts')).href)
try {
  loadConfig(process.env)
} catch (error) {
  console.error(`urutau-install: ${error instanceof Error ? error.message : 'the configuration is not valid'}`)
  process.exit(1)
}
CHECK_CONFIG_EOF
  cat > "$STAGING/port-free.cjs" <<'PORT_FREE_EOF'
// Written by install.sh and install.ps1 into <root>/.staging/port-free.cjs and run as
//   <node> <root>/.staging/port-free.cjs <host> <port>
// Exit 0: host:port can be bound now. Exit 1: it cannot (stderr names the error code,
// for example EADDRINUSE or EACCES).
const net = require('node:net')

const [host, port] = process.argv.slice(2)
const server = net.createServer()
server.once('error', (error) => {
  console.error(error.code ?? 'error')
  process.exit(1)
})
server.listen(Number(port), host, () => server.close(() => process.exit(0)))
PORT_FREE_EOF
}

# Builds .staging/urutau.env from the existing file (or a new one) and this run's options.
# Sets CONFIG_CHANGED (1 when it differs from the file in place, or there is none).
merge_config() {
  local staged="$STAGING/urutau.env" key
  if [ -f "$ROOT/urutau.env" ]; then
    cp "$ROOT/urutau.env" "$staged"
  else
    {
      printf '%s\n' '# Urutau server configuration. The installer wrote this file and keeps your edits.'
      printf '%s\n' '# One KEY=value per line, without quotes. Variables: https://github.com/oshogun/urutau#environment-variables'
    } > "$staged"
    env_set "$staged" HOST "${WANT_HOST:-127.0.0.1}"
    env_set "$staged" PORT "${PORT_ARG:-$DEFAULT_PORT}"
    env_set "$staged" DATABASE_URL "sqlite:$ROOT/data/urutau.db"
    # The key is generated once, for a new file only, by the private Node. It stays in
    # this shell variable: never printed, never on a command line, appended with a builtin.
    key="$(run_node "$NODE_DIR/bin/node" -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64'))" </dev/null)"
    [[ "$key" =~ ^[A-Za-z0-9+/]{43}=$ ]] || die "could not generate TOKEN_ENCRYPTION_KEY"
    printf 'TOKEN_ENCRYPTION_KEY=%s\n' "$key" >> "$staged"
    key=""
    [ -z "$WANT_PUBLIC_URL" ] || env_set "$staged" PUBLIC_URL "$WANT_PUBLIC_URL"
    [ -z "$ALLOWED_HOSTS_ARG" ] || env_set "$staged" ALLOWED_HOSTS "$ALLOWED_HOSTS_ARG"
    CONFIG_CHANGED=1
    return 0
  fi
  [ -z "$WANT_HOST" ] || env_set "$staged" HOST "$WANT_HOST"
  [ -z "$PORT_ARG" ] || env_set "$staged" PORT "$PORT_ARG"
  [ -z "$WANT_PUBLIC_URL" ] || env_set "$staged" PUBLIC_URL "$WANT_PUBLIC_URL"
  [ "$REMOVE_PUBLIC_URL" != 1 ] || env_remove "$staged" PUBLIC_URL
  [ -z "$ALLOWED_HOSTS_ARG" ] || env_set "$staged" ALLOWED_HOSTS "$ALLOWED_HOSTS_ARG"
  if grep -q '^[[:space:]]*TOKEN_ENCRYPTION_KEY[[:space:]]*=' "$ROOT/urutau.env"; then :; else
    warn "$ROOT/urutau.env has no TOKEN_ENCRYPTION_KEY, so agent integrations cannot store a GitHub token. The installer only creates a key for a new configuration; add one yourself (32 random bytes in base64)."
  fi
  if cmp -s "$staged" "$ROOT/urutau.env"; then CONFIG_CHANGED=0; else CONFIG_CHANGED=1; fi
}

# ---- service ------------------------------------------------------------

# Sets AUTOSTART to systemd-user or none. With --no-service no systemctl or loginctl
# command runs at all.
decide_autostart() {
  AUTOSTART=none
  [ "$NO_SERVICE" != 1 ] || return 0
  if [ -z "${XDG_RUNTIME_DIR:-}" ] && [ -d "/run/user/$(id -u)" ]; then
    XDG_RUNTIME_DIR="/run/user/$(id -u)"
    export XDG_RUNTIME_DIR
  fi
  if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1 </dev/null; then
    AUTOSTART=systemd-user
  fi
}

unit_path() { printf '%s/systemd/user/urutau.service' "${XDG_CONFIG_HOME:-$HOME/.config}"; }

write_unit() {
  local path
  path="$(unit_path)"
  mkdir -p "$(dirname "$path")"
  cat > "$path" <<UNIT
[Unit]
Description=Urutau kanban board server

[Service]
Type=simple
WorkingDirectory=$ROOT/app
UMask=0077
UnsetEnvironment=$SERVER_VARS
ExecStart="$ROOT/node/bin/node" "--env-file=$ROOT/urutau.env" "$ROOT/app/server/main.ts"
Restart=on-failure
RestartSec=5
TimeoutStopSec=15

[Install]
WantedBy=default.target
UNIT
}

log_command() {
  if [ "$AUTOSTART" = systemd-user ]; then printf 'journalctl --user -u urutau -f'; else printf '%s/.staging/trial.log' "$ROOT"; fi
}

start_command() {
  printf 'cd "%s/app" && "%s/node/bin/node" --env-file="%s/urutau.env" server/main.ts' "$ROOT" "$ROOT" "$ROOT"
}

# Starts the server in the background with no service, for the trial start that proves
# the install starts.
# The output goes to .staging/trial.log, or to the file named by $1.
start_trial() {
  local args=() v logfile="${1:-$STAGING/trial.log}"
  for v in $SERVER_VARS; do args+=(-u "$v"); done
  ( cd "$ROOT/app" && exec env "${args[@]}" "$ROOT/node/bin/node" "--env-file=$ROOT/urutau.env" "$ROOT/app/server/main.ts" ) \
    > "$logfile" 2>&1 </dev/null &
  TRIAL_PID=$!
}

stop_trial() {
  local i
  [ -n "$TRIAL_PID" ] || return 0
  kill -TERM "$TRIAL_PID" 2>/dev/null || true
  for i in $(seq 1 15); do
    kill -0 "$TRIAL_PID" 2>/dev/null || break
    sleep 1
  done
  if kill -0 "$TRIAL_PID" 2>/dev/null; then kill -KILL "$TRIAL_PID" 2>/dev/null || true; fi
  wait "$TRIAL_PID" 2>/dev/null || true
  TRIAL_PID=""
}

stop_server() {
  if [ "$AUTOSTART" = systemd-user ]; then
    systemctl --user stop urutau.service </dev/null 2>/dev/null || true
  else
    stop_trial
  fi
}

# Prints the last 20 lines of the trial server's output when it did not become healthy.
show_trial_log() {
  [ "$AUTOSTART" != systemd-user ] || return 0
  [ -f "$STAGING/trial.log" ] || return 0
  say "The last lines of $STAGING/trial.log:" >&2
  tail -n 20 "$STAGING/trial.log" >&2
}

# Starts the server: enable and restart the unit (then linger), or the trial process.
start_server() {
  if [ "$AUTOSTART" = systemd-user ]; then
    systemctl --user daemon-reload </dev/null || die "systemctl --user daemon-reload failed, so the new unit is not loaded."
    systemctl --user enable urutau.service </dev/null 2>/dev/null || die "systemctl --user enable urutau.service failed."
    systemctl --user restart urutau.service </dev/null || die "systemctl --user restart urutau.service failed. Logs: journalctl --user -u urutau"
  else
    start_trial
  fi
}

# Enables linger once, after the unit is enabled, unless --no-linger.
maybe_enable_linger() {
  local user current
  LINGER_BY_US="$M_LINGER"
  [ "$AUTOSTART" = systemd-user ] || return 0
  [ "$NO_LINGER" != 1 ] || return 0
  user="$(id -un)"
  current="$(loginctl show-user "$user" -p Linger --value 2>/dev/null </dev/null || true)"
  [ "$current" != yes ] || return 0
  if loginctl enable-linger "$user" 2>/dev/null </dev/null; then
    LINGER_BY_US=1
  else
    warn "could not enable linger, so Urutau starts at login only. Run: sudo loginctl enable-linger $user"
  fi
}

# ---- health ----------------------------------------------------------------------

# Sets PROBE_URL from the configuration at $1.
set_probe_url() {
  local host port
  host="$(env_get "$1" HOST)"; [ -n "$host" ] || host=127.0.0.1
  port="$(env_get "$1" PORT)"; [ -n "$port" ] || port="$DEFAULT_PORT"
  case "$host" in
    0.0.0.0|localhost) host=127.0.0.1 ;;
    "::"|"::1") host="[::1]" ;;
    *:*) [[ "$host" == \[* ]] || host="[$host]" ;;
  esac
  PROBE_URL="http://$host:$port"
}

# Waits up to $1 seconds for GET /api/health to answer 200.
wait_health() {
  local secs="$1" i code
  for ((i = 0; i < secs; i++)); do
    code="$(curl --noproxy '*' -sS --max-time 5 -o /dev/null -w '%{http_code}' "$PROBE_URL/api/health" </dev/null 2>/dev/null || true)"
    [ "$code" != 200 ] || return 0
    if [ -n "$TRIAL_PID" ] && ! kill -0 "$TRIAL_PID" 2>/dev/null; then return 1; fi
    sleep 1
  done
  return 1
}

# After a healthy answer: the process that answered is ours, not a foreign program.
own_process_ok() {
  local pid cmdline
  if [ "$AUTOSTART" = systemd-user ]; then
    [ "$(systemctl --user is-active urutau.service </dev/null 2>/dev/null || true)" = active ] || return 1
    pid="$(systemctl --user show urutau.service -p MainPID --value </dev/null 2>/dev/null || true)"
    [ -n "$pid" ] && [ "$pid" != 0 ] || return 1
    if [ -r "/proc/$pid/cmdline" ]; then
      cmdline="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)"
      case "$cmdline" in *"$ROOT/app/server/main.ts"*) return 0 ;; *) return 1 ;; esac
    fi
    return 0
  fi
  [ -n "$TRIAL_PID" ] && kill -0 "$TRIAL_PID" 2>/dev/null
}

# ---- backup --------------------------------------------------------------------------

# Prints the path of the SQLite database the configuration at $1 points at, or nothing
# when it is not a SQLite file (or is the in-memory database). A relative path is taken
# from the server's working directory, <root>/app.
db_path_of() {
  local url path
  url="$(env_get "$1" DATABASE_URL)"
  case "$url" in
    sqlite:*) ;;
    *) return 0 ;;
  esac
  [ "$url" != "sqlite::memory:" ] || return 0
  path="${url#sqlite:}"
  [[ "$path" == /* ]] || path="$ROOT/app/$path"
  printf '%s' "$path"
}

# Copies the SQLite database into backups/ when the old configuration points at one.
# Sets DB_BACKUP_DIR and DB_PATH.
backup_database() {
  local ts dir n=1 f base d key keep
  DB_BACKUP_DIR=""
  DB_PATH="$(db_path_of "$ROOT/urutau.env")"
  if [ -z "$DB_PATH" ]; then
    case "$(env_get "$ROOT/urutau.env" DATABASE_URL)" in
      sqlite:*) ;;
      *) say "The database is not a SQLite file, so the installer does not back it up. Back it up yourself before upgrading." ;;
    esac
    return 0
  fi
  [ -f "$DB_PATH" ] || return 0
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  base="$ROOT/backups/urutau-$M_VERSION"
  dir="$base-$ts"
  while [ -e "$dir" ]; do n=$((n + 1)); dir="$base-$ts-$n"; done
  mkdir -p "$dir"
  for f in "$DB_PATH" "$DB_PATH-wal" "$DB_PATH-shm"; do
    [ ! -e "$f" ] || cp -p "$f" "$dir/"
  done
  DB_BACKUP_DIR="$dir"
  say "Backed up the database to $dir."
  # Keep the three newest backup directories (greatest timestamp, then counter).
  keep=3
  for d in "$ROOT"/backups/urutau-*; do
    [ -d "$d" ] || continue
    n="${d##*/}"
    if [[ "$n" =~ ^urutau-.+-([0-9]{8}T[0-9]{6}Z)(-([0-9]+))?$ ]]; then
      key="${BASH_REMATCH[1]}_$(printf '%05d' "${BASH_REMATCH[3]:-1}")"
      printf '%s\t%s\n' "$key" "$d"
    fi
  done | LC_ALL=C sort | head -n -"$keep" | cut -f2- | while IFS= read -r d; do rm -rf "$d"; done
}

# ---- swap and rollback ----------------------------------------------------------------

swap_in() {
  rm -rf "$STAGING/old"
  mkdir -p "$STAGING/old"
  APP_SWAPPED=0; NODE_SWAPPED=0; CONFIG_SWAPPED=0
  if [ "$REPLACE_APP" = 1 ]; then
    if [ -e "$ROOT/app" ]; then mv "$ROOT/app" "$STAGING/old/app"; fi
    mv "$STAGING/app" "$ROOT/app"
    APP_SWAPPED=1
  fi
  if [ "$NODE_REPLACED" = 1 ]; then
    if [ -e "$ROOT/node" ]; then mv "$ROOT/node" "$STAGING/old/node"; fi
    mv "$STAGING/node" "$ROOT/node"
    NODE_SWAPPED=1
  fi
  if [ "$CONFIG_CHANGED" = 1 ]; then
    if [ -e "$ROOT/urutau.env" ]; then mv "$ROOT/urutau.env" "$STAGING/old/urutau.env"; fi
    mv "$STAGING/urutau.env" "$ROOT/urutau.env"
    CONFIG_SWAPPED=1
  fi
  chmod 600 "$ROOT/urutau.env"
  NODE_DIR="$ROOT/node"
}

# Puts the previous app, Node, configuration and database back, starts the old version,
# and ends the run with U3.
rollback() {
  local old_version="$M_VERSION" f
  stop_server
  mkdir -p "$STAGING/failed"
  if [ "$CONFIG_SWAPPED" = 1 ]; then
    rm -rf "$STAGING/failed/urutau.env"
    mv "$ROOT/urutau.env" "$STAGING/failed/urutau.env"
    mv "$STAGING/old/urutau.env" "$ROOT/urutau.env"
  fi
  if [ "$APP_SWAPPED" = 1 ]; then
    rm -rf "$STAGING/failed/app"
    mv "$ROOT/app" "$STAGING/failed/app"
    mv "$STAGING/old/app" "$ROOT/app"
  fi
  if [ "$NODE_SWAPPED" = 1 ]; then
    rm -rf "$STAGING/failed/node"
    mv "$ROOT/node" "$STAGING/failed/node"
    mv "$STAGING/old/node" "$ROOT/node"
  fi
  if [ -n "$DB_BACKUP_DIR" ]; then
    rm -f "$DB_PATH" "$DB_PATH-wal" "$DB_PATH-shm"
    for f in "$DB_BACKUP_DIR"/*; do cp -p "$f" "$(dirname "$DB_PATH")/"; done
  fi
  set_probe_url "$ROOT/urutau.env"
  # The failed version's trial.log stays for the admin to read; the restored version
  # writes its own file.
  if [ "$AUTOSTART" = systemd-user ]; then start_server; else start_trial "$STAGING/trial-restored.log"; fi
  if ! wait_health 30 || ! own_process_ok; then
    warn "the restored version did not answer on $PROBE_URL/api/health within 30 seconds either. Logs: $(log_command)"
  fi
  # With no service the old version only proved it starts: it is not left running.
  if [ "$AUTOSTART" != systemd-user ]; then stop_trial; fi
  {
    if [ "$AUTOSTART" = systemd-user ]; then
      say "error: Urutau $NEW_VERSION did not answer on $PROBE_URL/api/health within 60 seconds."
    else
      say "error: Urutau $NEW_VERSION did not start: nothing answered on $PROBE_URL/api/health."
    fi
    if [ -n "$DB_BACKUP_DIR" ]; then
      say "The previous version, $old_version, was restored with its configuration and with its database as it was before the upgrade."
    else
      say "The previous version, $old_version, was restored with its configuration."
    fi
    say "Logs: $(log_command)"
    say "Going back to an older version? A database that a newer version has migrated needs the steps in https://github.com/oshogun/urutau#downgrading-past-the-integrations"
  } >&2
  exit 1
}

# ---- output -------------------------------------------------------

print_first_run_notice() {
  local body url public host
  body="$(curl --noproxy '*' -sS --max-time 5 "$PROBE_URL/api/session" </dev/null 2>/dev/null || true)"
  # A failed request prints N1 as well; only a known "firstRun":false prints nothing.
  case "$body" in
    *'"firstRun":false'*) return 0 ;;
  esac
  public="$(env_get "$ROOT/urutau.env" PUBLIC_URL)"
  host="$(env_get "$ROOT/urutau.env" HOST)"
  url="${public:-$PROBE_URL}"
  case "$host" in ""|127.*|localhost|"::1") host=loopback ;; esac
  if [ -n "$public" ] && [ "$host" != loopback ]; then
    say ""
    say "Urutau is reachable from other computers at $public."
    say "Nobody has an account yet, and whoever opens it first becomes the admin."
    say "Open $public now and create the admin account. Use that address on"
    say "this computer too: Urutau refuses sign-ins that come from any other address."
  else
    say ""
    say "Open $url now to create the admin account."
  fi
}

database_label() {
  local url
  url="$(env_get "$ROOT/urutau.env" DATABASE_URL)"
  case "$url" in
    sqlite:*) printf '%s' "${url#sqlite:}" ;;
    *) printf 'set by DATABASE_URL in the configuration' ;;
  esac
}

uninstall_command() {
  local extra=""
  if [ "$ROOT" != "${XDG_DATA_HOME:-$HOME/.local/share}/urutau" ]; then extra=" --install-dir \"$ROOT\""; fi
  printf 'curl -fsSL %s | bash -s -- --uninstall%s' "$UNINSTALL_URL" "$extra"
}

print_summary() {
  local url
  url="$(env_get "$ROOT/urutau.env" PUBLIC_URL)"
  [ -n "$url" ] || url="$PROBE_URL"
  say ""
  if [ "$AUTOSTART" = systemd-user ]; then
    say "Urutau $1 is running at $url"
    say ""
    say "  Install directory  $ROOT"
    say "  Configuration      $ROOT/urutau.env"
    say "  Database           $(database_label)"
    say "  Logs               $(log_command)"
    say "  Upgrade            run the install command again"
    say "  Uninstall          $(uninstall_command)"
  else
    say "Urutau $1 is installed in $ROOT. It is not registered as a service, and it is not running."
    say "Start it with:"
    say "  $(start_command)"
    say ""
    say "  Configuration      $ROOT/urutau.env"
    say "  Database           $(database_label)"
    say "  Upgrade            run the install command again"
    say "  Uninstall          $(uninstall_command)"
  fi
}

# ---- install ----------------------------------------------------------------------------------------------------

do_install() {
  local new_config=0 want_port old_port check_port=0 host_now port_now port_changes
  [ -f "$ROOT/urutau.env" ] || new_config=1

  if [ -d "$ROOT" ] && [ -n "$(ls -A "$ROOT" 2>/dev/null)" ] && [ ! -f "$ROOT/.urutau-install" ]; then
    die "$ROOT exists, is not empty, and is not an Urutau install. Choose another --install-dir."
  fi

  # Address decision every option first, then the question, then the
  # unattended default.
  # The port Urutau will listen on: --port, else the one already in the configuration.
  want_port="${PORT_ARG:-$(env_get "$ROOT/urutau.env" PORT)}"
  [ -n "$want_port" ] || want_port="$DEFAULT_PORT"
  WANT_HOST=""; WANT_PUBLIC_URL=""; REMOVE_PUBLIC_URL=0
  if [ -n "$PUBLIC_URL_ARG" ]; then
    parse_address "$PUBLIC_URL_ARG" "$want_port" flag
    [ "$PA_KIND" = url ] || die "--public-url is not an address Urutau can use: $(reason_text "$PA_REASON" "$want_port")."
    WANT_PUBLIC_URL="$PA_URL"
    WANT_HOST="${BIND_HOST_ARG:-0.0.0.0}"
  elif [ "$LOCAL" = 1 ]; then
    WANT_HOST=127.0.0.1; REMOVE_PUBLIC_URL=1
  elif [ -n "$BIND_HOST_ARG" ]; then
    WANT_HOST="$BIND_HOST_ARG"
  elif [ "$new_config" = 1 ]; then
    if [ "$ASSUME_YES" != 1 ] && have_tty; then
      ask_address "$want_port"
    else
      WANT_HOST=127.0.0.1
      if [ "$ASSUME_YES" = 1 ]; then
        say "--yes was given, so Urutau listens on this computer only (http://127.0.0.1:$want_port)."
      else
        say "No terminal to answer on, so Urutau listens on this computer only (http://127.0.0.1:$want_port)."
      fi
      say "To open it to other computers, re-run with --public-url <address>."
    fi
  fi
  [ -z "$WANT_PUBLIC_URL" ] || warn_url_port "$WANT_PUBLIC_URL" "$want_port"

  umask 077
  mkdir -p "$ROOT"
  chmod 700 "$ROOT"
  STAGING="$ROOT/.staging"
  mkdir "$ROOT/.install.lock" 2>/dev/null \
    || die "another install or upgrade is running (lock: $ROOT/.install.lock). If none is, delete that directory and run again."
  LOCK_HELD=1
  mkdir -p "$STAGING"
  read_marker
  if [ "$HAVE_MARKER" = 0 ]; then
    write_marker installing "" "" "" 0
    read_marker
  fi
  if [ "$NO_SERVICE" = 1 ] && [ "$M_AUTOSTART" = systemd-user ] && [ "$M_STATE" = installed ]; then
    die "this install is registered as a service. Uninstall it first, or run without --no-service."
  fi
  OLD_HAD_APP=0
  [ -f "$ROOT/app/server/main.ts" ] && [ "$M_STATE" = installed ] && OLD_HAD_APP=1

  # A re-run that only changes configuration options keeps the installed version and Node:
  # it looks up no release and downloads nothing, so it also works offline. Running the
  # installer again without options upgrades.
  CONFIG_ONLY=0
  # --port counts only when it changes the port: an unchanged value is not a request to keep
  # the installed version.
  port_changes=""
  if [ -n "$PORT_ARG" ] && [ "$PORT_ARG" != "$(env_get "$ROOT/urutau.env" PORT)" ]; then port_changes="$PORT_ARG"; fi
  if [ "$HAVE_MARKER" = 1 ] && [ "$M_STATE" = installed ] && [ -n "$M_VERSION" ] && [ -z "$VERSION_ARG" ] && [ -z "$BUNDLE" ] \
     && [ "$FORCE" != 1 ] && [ -f "$ROOT/app/server/main.ts" ] && [ -x "$ROOT/node/bin/node" ] \
     && { [ -n "$PUBLIC_URL_ARG$BIND_HOST_ARG$ALLOWED_HOSTS_ARG$port_changes" ] || [ "$LOCAL" = 1 ]; }; then
    CONFIG_ONLY=1
    log "Only configuration options were given, so Urutau $M_VERSION stays installed. Run the installer again without options to upgrade."
    NODE_REPLACED=0; NODE_DIR="$ROOT/node"; NODE_VERSION="$M_NODE"
  else
    ensure_node
  fi

  # Version and bundle.
  REPLACE_APP=1
  VERSION=""
  if [ "$CONFIG_ONLY" = 1 ]; then
    VERSION="$M_VERSION"
  elif [ -n "$BUNDLE" ]; then
    :
  elif [ -n "$VERSION_ARG" ]; then
    VERSION="$VERSION_ARG"
  else
    lookup_latest
  fi
  if [ -z "$BUNDLE" ] && [ "$M_VERSION" = "$VERSION" ] && [ -f "$ROOT/app/server/main.ts" ] && [ "$FORCE" != 1 ] && [ "$M_STATE" = installed ]; then
    REPLACE_APP=0
  fi
  if [ "$REPLACE_APP" = 1 ]; then
    fetch_bundle
    npm_ci
    CHECK_APP="$STAGING/app"
    NEW_VERSION="$VERSION"
  else
    CHECK_APP="$ROOT/app"
    NEW_VERSION="$M_VERSION"
  fi

  write_helpers
  merge_config
  set_probe_url "$STAGING/urutau.env"
  host_now="$(env_get "$STAGING/urutau.env" HOST)"; [ -n "$host_now" ] || host_now=127.0.0.1
  port_now="$(env_get "$STAGING/urutau.env" PORT)"; [ -n "$port_now" ] || port_now="$DEFAULT_PORT"

  # The new version checks the configuration before anything is stopped.
  local msg
  if ! msg="$(run_node "$NODE_DIR/bin/node" "--env-file=$STAGING/urutau.env" "$STAGING/check-config.mjs" "$CHECK_APP" 2>&1 </dev/null)"; then
    msg="$(printf '%s' "$msg" | head -n1)"
    msg="${msg#urutau-install: }"
    die "the configuration in $ROOT/urutau.env is not valid for Urutau $NEW_VERSION: $msg. Nothing was changed."
  fi

  decide_autostart

  # The port must be free when nothing of ours holds it: a new configuration, an install that
  # was not running, a changed port, or no service (the trial start needs it).
  old_port="$(env_get "$ROOT/urutau.env" PORT)"; [ -n "$old_port" ] || old_port="$DEFAULT_PORT"
  if [ "$new_config" = 1 ] || [ "$M_STATE" != installed ] || [ "$AUTOSTART" = none ] || [ "$M_AUTOSTART" = none ] || [ "$port_now" != "$old_port" ]; then
    check_port=1
  fi
  if [ "$check_port" = 1 ]; then
    if ! run_node "$NODE_DIR/bin/node" "$STAGING/port-free.cjs" "$host_now" "$port_now" >/dev/null 2>&1 </dev/null; then
      die "port $port_now on $host_now is in use by another program. Nothing was changed. Re-run with --port N."
    fi
  fi

  if [ "$REPLACE_APP" = 0 ] && [ "$NODE_REPLACED" = 0 ] && [ "$CONFIG_CHANGED" = 0 ] && [ "$M_STATE" = installed ] \
     && [ "$AUTOSTART" = "$M_AUTOSTART" ] && { [ "$AUTOSTART" = none ] || [ -f "$(unit_path)" ]; }; then
    say "Urutau $M_VERSION is already installed in $ROOT, with this configuration. Nothing to do."
    rm -rf "$STAGING"
    print_summary "$M_VERSION"
    return 0
  fi

  # Nothing above changed anything a running install uses. From here on it does.
  if [ "$REPLACE_APP" = 1 ] || [ "$NODE_REPLACED" = 1 ]; then
    if [ "$OLD_HAD_APP" = 1 ]; then
      case "$(db_path_of "$ROOT/urutau.env")" in
        "$ROOT"/app/*) die "the database is inside $ROOT/app, which this upgrade replaces. Move it, and set DATABASE_URL, first. Nothing was changed." ;;
      esac
    fi
  fi
  DB_BACKUP_DIR=""; DB_PATH=""
  stop_server
  if [ "$OLD_HAD_APP" = 1 ] && { [ "$REPLACE_APP" = 1 ] || [ "$NODE_REPLACED" = 1 ]; }; then
    backup_database
  fi
  swap_in
  mkdir -p "$ROOT/data"
  LINGER_BY_US="$M_LINGER"
  if [ "$AUTOSTART" = systemd-user ]; then write_unit; fi
  # The service definition is recorded before the start, so an uninstall can remove what a
  # failed fresh install left registered.
  if [ "$OLD_HAD_APP" = 1 ]; then
    write_marker installed "$M_VERSION" "$M_NODE" "$AUTOSTART" "$M_LINGER"
  else
    write_marker installing "" "" "$AUTOSTART" "$M_LINGER"
  fi
  start_server
  if [ "$AUTOSTART" = systemd-user ]; then
    maybe_enable_linger
    write_marker "$([ "$OLD_HAD_APP" = 1 ] && printf installed || printf installing)" "$M_VERSION" "$M_NODE" "$AUTOSTART" "$LINGER_BY_US"
  fi
  M_LINGER="$LINGER_BY_US"

  if wait_health 60 && own_process_ok; then
    :
  elif [ "$OLD_HAD_APP" = 1 ]; then
    show_trial_log
    rollback
  else
    show_trial_log
    stop_server
    if [ "$AUTOSTART" = systemd-user ]; then
      die "Urutau $NEW_VERSION did not answer on $PROBE_URL/api/health within 60 seconds. It is left installed so you can read its logs: $(log_command)"
    fi
    die "Urutau $NEW_VERSION did not start: nothing answered on $PROBE_URL/api/health. It is left installed so you can read its logs: $(log_command)"
  fi

  M_VERSION="$NEW_VERSION"
  write_marker installed "$NEW_VERSION" "${NODE_VERSION}" "$AUTOSTART" "$M_LINGER"
  print_first_run_notice
  if [ "$AUTOSTART" != systemd-user ]; then stop_trial; fi
  rm -rf "$STAGING"
  print_summary "$NEW_VERSION"
}

# ---- uninstall ---------------------------------------------------------------------------------

do_uninstall() {
  local user answer
  [ -f "$ROOT/.urutau-install" ] || die "$ROOT is not an Urutau install: there is no .urutau-install file there."
  mkdir "$ROOT/.install.lock" 2>/dev/null \
    || die "another install or upgrade is running (lock: $ROOT/.install.lock). If none is, delete that directory and run again."
  LOCK_HELD=1
  ARCH=unknown
  read_marker
  if [ "$M_STATE" != uninstalled ]; then
    # What is removed comes from the marker, not from the options of this run.
    case "$M_AUTOSTART" in
      systemd-user)
        systemctl --user disable --now urutau.service </dev/null 2>/dev/null || warn "could not disable urutau.service; it may already be gone."
        rm -f "$(unit_path)"
        systemctl --user daemon-reload </dev/null 2>/dev/null || true
        ;;
      *) ;;
    esac
    if [ "$M_AUTOSTART" = systemd-user ] && [ "$M_LINGER" = 1 ] && [ "$NO_LINGER" != 1 ]; then
      user="$(id -un)"
      loginctl disable-linger "$user" </dev/null 2>/dev/null || warn "could not disable linger. Run: loginctl disable-linger $user"
    fi
    local name
    for name in app node bin run .staging; do rm -rf "${ROOT:?}/$name"; done
    ARCH="$(grep '^arch=' "$ROOT/.urutau-install" | head -n1 | cut -d= -f2- || true)"
    write_marker uninstalled "$M_VERSION" "$M_NODE" none 0
  fi
  rmdir "$ROOT/.install.lock" 2>/dev/null || true
  LOCK_HELD=0
  say "Removed the Urutau service and application from $ROOT."
  say "Kept: urutau.env, data/, backups/, logs/. Installing again in the same directory reuses them."

  if [ "$DO_PURGE" = 1 ]; then
    if [ "$ASSUME_YES" != 1 ]; then
      if have_tty; then
        printf 'Type "purge" to delete %s, including the database and its backups: ' "$ROOT" > /dev/tty
        answer=""
        read -r answer < /dev/tty || true
        [ "$answer" = purge ] || die "purge cancelled."
      else
        die "--purge without a terminal needs --yes."
      fi
    fi
    rm -rf "${ROOT:?}"
    say "Purged $ROOT."
  fi
}

# ---- main -----------------------------------------------------------------------------------------------------------

main() {
  set -euo pipefail
  # Nothing this script starts may read the rest of the script from stdin (curl | bash).
  exec </dev/null
  trap on_exit EXIT
  umask 077

  VERSION_ARG="${URUTAU_VERSION:-}"
  BUNDLE="${URUTAU_BUNDLE:-}"
  INSTALL_DIR_ARG="${URUTAU_INSTALL_DIR:-}"
  # An empty value must not fall back to the default root: with --uninstall --purge --yes
  # a mistyped variable would delete the default install.
  INSTALL_DIR_GIVEN=0
  INSTALL_DIR_VAR_EMPTY=0
  if [ -n "${URUTAU_INSTALL_DIR+set}" ]; then
    if [ -n "$URUTAU_INSTALL_DIR" ]; then INSTALL_DIR_GIVEN=1; else INSTALL_DIR_VAR_EMPTY=1; fi
  fi
  PORT_ARG="${URUTAU_PORT:-}"
  PUBLIC_URL_ARG="${URUTAU_PUBLIC_URL:-}"
  BIND_HOST_ARG="${URUTAU_BIND_HOST:-}"
  ALLOWED_HOSTS_ARG="${URUTAU_ALLOWED_HOSTS:-}"
  LOCAL=0; [ "${URUTAU_LOCAL:-}" != 1 ] || LOCAL=1
  NO_SERVICE=0; [ "${URUTAU_NO_SERVICE:-}" != 1 ] || NO_SERVICE=1
  FORCE=0; [ "${URUTAU_FORCE:-}" != 1 ] || FORCE=1
  DO_UNINSTALL=0; [ "${URUTAU_UNINSTALL:-}" != 1 ] || DO_UNINSTALL=1
  DO_PURGE=0; [ "${URUTAU_PURGE:-}" != 1 ] || DO_PURGE=1
  ASSUME_YES=0; [ "${URUTAU_YES:-}" != 1 ] || ASSUME_YES=1
  NO_LINGER=0; [ "${URUTAU_NO_LINGER:-}" != 1 ] || NO_LINGER=1
  ARCH=x64
  NODE_REPLACED=0
  NODE_VERSION=""
  CONFIG_CHANGED=0

  while [ $# -gt 0 ]; do
    case "$1" in
      --version) [ $# -ge 2 ] || die "--version needs a value"; VERSION_ARG="$2"; shift 2 ;;
      --bundle) [ $# -ge 2 ] || die "--bundle needs a value"; BUNDLE="$2"; shift 2 ;;
      --install-dir) { [ $# -ge 2 ] && [ -n "$2" ]; } || die "--install-dir needs a value"; INSTALL_DIR_ARG="$2"; INSTALL_DIR_GIVEN=1; INSTALL_DIR_VAR_EMPTY=0; shift 2 ;;
      --port) [ $# -ge 2 ] || die "--port needs a value"; PORT_ARG="$2"; shift 2 ;;
      --public-url) [ $# -ge 2 ] || die "--public-url needs a value"; PUBLIC_URL_ARG="$2"; shift 2 ;;
      --local) LOCAL=1; shift ;;
      --bind-host) [ $# -ge 2 ] || die "--bind-host needs a value"; BIND_HOST_ARG="$2"; shift 2 ;;
      --allowed-hosts) [ $# -ge 2 ] || die "--allowed-hosts needs a value"; ALLOWED_HOSTS_ARG="$2"; shift 2 ;;
      --no-service) NO_SERVICE=1; shift ;;
      --force) FORCE=1; shift ;;
      --uninstall) DO_UNINSTALL=1; shift ;;
      --purge) DO_PURGE=1; shift ;;
      --yes) ASSUME_YES=1; shift ;;
      --no-linger) NO_LINGER=1; shift ;;
      --help|-h) usage; exit 0 ;;
      *) die "unrecognised argument: $1 (see --help)" ;;
    esac
  done

  if [ "$DO_PURGE" = 1 ] && [ "$DO_UNINSTALL" != 1 ]; then die "--purge needs --uninstall."; fi
  if [ "$LOCAL" = 1 ] && { [ -n "$PUBLIC_URL_ARG" ] || [ -n "$BIND_HOST_ARG" ]; }; then
    die "--local cannot be combined with --public-url or --bind-host."
  fi
  if [ -n "$PORT_ARG" ]; then
    case "$PORT_ARG" in
      *[!0-9]*) die "--port must be a number from 1024 to 65535" ;;
    esac
    if [ "${#PORT_ARG}" -gt 5 ] || [ "$((10#$PORT_ARG))" -lt 1024 ] || [ "$((10#$PORT_ARG))" -gt 65535 ]; then
      die "--port must be a number from 1024 to 65535"
    fi
    PORT_ARG="$((10#$PORT_ARG))"
  fi
  if [ -n "$VERSION_ARG" ]; then
    VERSION_ARG="${VERSION_ARG#v}"
    [[ "$VERSION_ARG" =~ $VERSION_RE ]] || die "--version must look like X.Y.Z or X.Y.Z-PRERELEASE: $VERSION_ARG"
    if is_no_bundle_version "$VERSION_ARG"; then
      die "Urutau $VERSION_ARG has no installer bundle. Releases v0.1.0 to v0.5.0 were published before the installers existed. Run $VERSION_ARG with Docker (ghcr.io/oshogun/urutau:$VERSION_ARG) or from a source checkout."
    fi
  fi
  if [ -n "$PUBLIC_URL_ARG" ]; then check_plain_value "--public-url" "$PUBLIC_URL_ARG"; fi
  if [ -n "$ALLOWED_HOSTS_ARG" ]; then check_plain_value "--allowed-hosts" "$ALLOWED_HOSTS_ARG"; fi
  if [ -n "$BIND_HOST_ARG" ]; then check_plain_value "--bind-host" "$BIND_HOST_ARG"; fi

  require_cmd curl tar gzip sha256sum awk sed grep
  check_platform

  # The flag wins over the variable, so an empty variable is refused only without the flag.
  if [ "$INSTALL_DIR_VAR_EMPTY" = 1 ]; then die "URUTAU_INSTALL_DIR is set but empty."; fi
  if [ "$INSTALL_DIR_GIVEN" = 1 ]; then
    case "$INSTALL_DIR_ARG" in
      /*) ROOT="$INSTALL_DIR_ARG" ;;
      *) ROOT="$PWD/$INSTALL_DIR_ARG" ;;
    esac
  else
    ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/urutau"
  fi
  validate_root

  if [ -n "$BUNDLE" ]; then
    case "$BUNDLE" in
      http://*|https://*) ;;
      /*) ;;
      *) BUNDLE="$PWD/$BUNDLE" ;;
    esac
  fi

  if [ "$DO_UNINSTALL" = 1 ]; then
    do_uninstall
  else
    do_install
  fi
}

main "$@"
