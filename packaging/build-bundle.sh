#!/usr/bin/env bash
# Packages a reproducible server bundle from an already-built tree.
#
# Usage: packaging/build-bundle.sh <version> <out-dir>
#
# Preconditions: `npm ci && npm run build` already ran, so dist/index.html exists at the
# repo root. This script never runs npm or a build itself: it copies the Dockerfile's
# runtime tree, removes what the Dockerfile removes, and archives the result.
#
# Output, in <out-dir>:
#   urutau-server-<version>.tar.gz          one top-level directory, urutau-server-<version>/
#   urutau-server-<version>.tar.gz.sha256   `sha256sum` line: "<hash>  <file name>"
# The archive is reproducible: the same commit and build give the same bytes.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

VERSION="${1:-}"
OUT_DIR="${2:-}"

if [ -z "$VERSION" ] || [ -z "$OUT_DIR" ]; then
  echo "usage: $0 <version> <out-dir>" >&2
  exit 1
fi

# X.Y.Z, optionally followed by a semver 2.0 prerelease (-alpha, -beta.1, ...).
# No build metadata (+...): a bundle name and a release tag both need to stay one
# unambiguous string, and semver ignores build metadata when comparing versions, so two
# different bundles would collide.
SEMVER_IDENT='(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)'
VERSION_RE="^[0-9]+\\.[0-9]+\\.[0-9]+(-${SEMVER_IDENT}(\\.${SEMVER_IDENT})*)?\$"
if ! [[ "$VERSION" =~ $VERSION_RE ]]; then
  echo "error: version '$VERSION' does not match X.Y.Z or X.Y.Z-PRERELEASE (semver 2.0 prerelease identifiers)" >&2
  exit 1
fi

if [ ! -f "$REPO_ROOT/dist/index.html" ]; then
  echo "error: dist/index.html must exist before running this script (run npm run build first)" >&2
  exit 1
fi

# The archive's modification time is the commit time. A made-up time (0) would give a
# bundle that cannot be rebuilt to the same bytes from the same commit later, so a failed
# lookup is an error.
COMMIT_TIME="$(git -C "$REPO_ROOT" log -1 --format=%ct)" || {
  echo "error: could not read the commit time of HEAD with git log" >&2
  exit 1
}
if ! [[ "$COMMIT_TIME" =~ ^[0-9]+$ ]]; then
  echo "error: could not read the commit time of HEAD with git log" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"

STAGE_NAME="urutau-server-$VERSION"
STAGE_DIR="$OUT_DIR/$STAGE_NAME"
TARBALL="$OUT_DIR/$STAGE_NAME.tar.gz"

if [ -e "$STAGE_DIR" ]; then
  echo "error: staging directory $STAGE_DIR already exists" >&2
  exit 1
fi

mkdir -p "$STAGE_DIR"
# A failed step below must not leave the staging directory behind (the next run in this
# out-dir would refuse with "already exists"), nor a partial tarball or .sha256 (a later
# `sha256sum -c` or `tar -tzf` would fail against it).
# shellcheck disable=SC2154 # rc is assigned inside the trap's own command string
trap 'rc=$?; rm -rf "$STAGE_DIR"; [ "$rc" = 0 ] || rm -f "$TARBALL" "$TARBALL.sha256"' EXIT

cp -R "$REPO_ROOT/dist" "$STAGE_DIR/dist"
cp -R "$REPO_ROOT/server" "$STAGE_DIR/server"
mkdir -p "$STAGE_DIR/src/github"
cp -R "$REPO_ROOT/src/domain" "$STAGE_DIR/src/domain"
cp "$REPO_ROOT/src/github/api.ts" "$REPO_ROOT/src/github/paging.ts" "$STAGE_DIR/src/github/"
cp "$REPO_ROOT/package.json" "$STAGE_DIR/package.json"
cp "$REPO_ROOT/package-lock.json" "$STAGE_DIR/package-lock.json"
cp "$REPO_ROOT/LICENSE" "$STAGE_DIR/LICENSE"
printf '%s\n' "$VERSION" > "$STAGE_DIR/VERSION"

# The same removals as the Dockerfile's build stage: the tests, and the helpers that only
# tests import (connector.suite.ts imports vitest, a dev dependency).
find "$STAGE_DIR/server" "$STAGE_DIR/src" -name '*.test.ts' -delete
rm -rf "$STAGE_DIR/server/testing" \
  "$STAGE_DIR/server/oidc/support.ts" \
  "$STAGE_DIR/server/oidc/fakeKeycloak.ts" \
  "$STAGE_DIR/server/db/connector.suite.ts"

# Lists the names directly inside a directory, sorted in the C locale on one line.
entries_of() {
  (cd "$1" && find . -mindepth 1 -maxdepth 1 -printf '%f\n' | LC_ALL=C sort | tr '\n' ' ' | sed 's/ $//')
}

EXPECTED_ENTRIES="LICENSE VERSION dist package-lock.json package.json server src"

check_entries() {
  local what="$1" actual="$2" expected="$3"
  if [ "$actual" != "$expected" ]; then
    echo "error: $what does not match the expected list" >&2
    echo "  expected: $expected" >&2
    echo "  actual:   $actual" >&2
    exit 1
  fi
}

# Run once on the staging directory and once on the archive's listing.
check_listing() {
  local what="$1" listing="$2" bad
  bad="$(printf '%s\n' "$listing" | grep -E '\.test\.ts$|/server/testing(/|$)|/(support|fakeKeycloak|connector\.suite)\.ts$' || true)"
  if [ -n "$bad" ]; then
    echo "error: $what holds files that must not ship:" >&2
    printf '%s\n' "$bad" >&2
    exit 1
  fi
}

check_entries "staged bundle entries" "$(entries_of "$STAGE_DIR")" "$EXPECTED_ENTRIES"
check_entries "staged src entries" "$(entries_of "$STAGE_DIR/src")" "domain github"
check_entries "staged src/github entries" "$(entries_of "$STAGE_DIR/src/github")" "api.ts paging.ts"
check_listing "the staged bundle" "$(cd "$OUT_DIR" && find "$STAGE_NAME" -type f)"

# tar and gzip flags: entries sorted by name in the C locale, owner and group 0, modes
# normalized so the builder's umask does not show, mtime fixed, and `gzip -n` leaves the
# file name and time out of the gzip header.
(
  cd "$OUT_DIR"
  LC_ALL=C tar --format=gnu --sort=name --owner=0 --group=0 --numeric-owner \
      --mtime="@$COMMIT_TIME" --mode='u+rwX,go+rX,go-w' \
      -cf - "$STAGE_NAME" | gzip -n -9 > "$TARBALL"
)

LISTING="$(tar -tzf "$TARBALL")"
check_entries "tarball entries" \
  "$(printf '%s\n' "$LISTING" | cut -d/ -f2 | grep -v '^$' | LC_ALL=C sort -u | tr '\n' ' ' | sed 's/ $//')" \
  "$EXPECTED_ENTRIES"
check_listing "the tarball" "$LISTING"

(
  cd "$OUT_DIR"
  sha256sum "$STAGE_NAME.tar.gz" > "$STAGE_NAME.tar.gz.sha256"
)

echo "$TARBALL"
echo "$TARBALL.sha256"
