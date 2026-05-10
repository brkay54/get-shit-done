#!/usr/bin/env bash
# GSD install: symlinks get-shit-done/ into .claude/get-shit-done in each target project.
# Idempotent — re-running is safe.

set -euo pipefail

FORK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GSD_SOURCE="$FORK_DIR/get-shit-done"

PROJECTS=(
  "$HOME/projects/abot"
  "$HOME/projects/course-app"
)

echo "GSD install"
echo "  source: $GSD_SOURCE"
echo ""

ok=0; linked=0; skipped=0; errors=0

for PROJECT in "${PROJECTS[@]}"; do
  TARGET="$PROJECT/.claude/get-shit-done"

  if [ ! -d "$PROJECT" ]; then
    echo "  SKIP    $PROJECT — directory not found"
    (( skipped++ )) || true
    continue
  fi

  # Already a correct symlink — nothing to do.
  if [ -L "$TARGET" ] && [ "$(readlink -f "$TARGET" 2>/dev/null)" = "$(readlink -f "$GSD_SOURCE")" ]; then
    echo "  OK      $PROJECT"
    (( ok++ )) || true
    continue
  fi

  # Replace plain directory or stale symlink.
  if [ -e "$TARGET" ] || [ -L "$TARGET" ]; then
    rm -rf "$TARGET"
  fi

  mkdir -p "$PROJECT/.claude"
  ln -s "$GSD_SOURCE" "$TARGET"
  echo "  LINKED  $PROJECT"
  (( linked++ )) || true
done

echo ""
echo "done — $linked linked, $ok already ok, $skipped skipped, $errors errors"
