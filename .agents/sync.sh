#!/usr/bin/env bash
set -euo pipefail

AGENTS_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$AGENTS_DIR/.." && pwd)"

check_mode=false
if [[ "${1:-}" == "--check" ]]; then
  check_mode=true
fi

# Ensure a symlink exists from dest -> target, or check it in check mode.
# Both paths are relative to ROOT_DIR.
sync_link() {
  local target="$1" dest="$2"
  local dest_abs="$ROOT_DIR/$dest"

  if $check_mode; then
    if [[ ! -L "$dest_abs" ]]; then
      echo "NOT A SYMLINK: $dest" >&2
      return 1
    fi
    local current
    current="$(readlink "$dest_abs")"
    if [[ "$current" != "$target" ]]; then
      echo "WRONG TARGET: $dest -> $current (expected $target)" >&2
      return 1
    fi
  else
    ln -sf "$target" "$dest_abs"
  fi
}

# Copy a file to a destination, or check it matches
sync_file() {
  local src="$1" dest="$2"
  local content
  content=$(<"$src")

  if $check_mode; then
    if [[ ! -f "$dest" ]]; then
      echo "MISSING: $dest" >&2
      return 1
    fi
    local existing
    existing=$(<"$dest")
    if [[ "$content" != "$existing" ]]; then
      echo "OUT OF SYNC: $dest" >&2
      return 1
    fi
  else
    mkdir -p "$(dirname "$dest")"
    printf '%s' "$content" > "$dest"
  fi
}

failed=false

# Symlink INSTRUCTIONS.md -> AGENTS.md and CLAUDE.md
for dest_name in AGENTS.md CLAUDE.md; do
  if ! sync_link ".agents/INSTRUCTIONS.md" "$dest_name"; then
    failed=true
  fi
done

# Symlink INSTRUCTIONS.alpha.md -> AGENTS.alpha.md
if [[ -f "$AGENTS_DIR/INSTRUCTIONS.alpha.md" ]]; then
  if ! sync_link ".agents/INSTRUCTIONS.alpha.md" "AGENTS.alpha.md"; then
    failed=true
  fi
fi

# Sync skills to .claude/skills/ and .codex/skills/
for skill_dir in "$AGENTS_DIR"/skills/*/; do
  skill_name="$(basename "$skill_dir")"
  src="$skill_dir/SKILL.md"
  [[ -f "$src" ]] || continue

  for target in claude codex; do
    dest="$ROOT_DIR/.$target/skills/$skill_name/SKILL.md"
    if ! sync_file "$src" "$dest"; then
      failed=true
    fi
  done
done

# Prune skills that no longer exist in .agents/skills/
for target in claude codex; do
  target_skills_dir="$ROOT_DIR/.$target/skills"
  [[ -d "$target_skills_dir" ]] || continue
  for dest_skill_dir in "$target_skills_dir"/*/; do
    [[ -d "$dest_skill_dir" ]] || continue
    skill_name="$(basename "$dest_skill_dir")"
    if [[ ! -d "$AGENTS_DIR/skills/$skill_name" ]]; then
      if $check_mode; then
        echo "STALE: $dest_skill_dir" >&2
        failed=true
      else
        rm -rf "$dest_skill_dir"
      fi
    fi
  done
done

if $failed; then
  echo "Sync check failed. Run 'npm run agents:sync' to fix." >&2
  exit 1
fi

if ! $check_mode; then
  echo "Synced agent configs." >&2
fi
