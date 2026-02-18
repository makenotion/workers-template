#!/usr/bin/env bash
set -euo pipefail

AGENTS_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$AGENTS_DIR/.." && pwd)"

check_mode=false
if [[ "${1:-}" == "--check" ]]; then
  check_mode=true
fi

# Parse vars from config.toml (supports nested sections like [vars.coauthor])
# Uses parallel arrays instead of associative arrays for Bash 3.2 compatibility.
var_keys=()
var_values=()
in_vars=false
current_prefix=""
while IFS= read -r line; do
  if [[ "$line" =~ ^\[vars\]$ ]]; then
    in_vars=true
    current_prefix=""
  elif [[ "$line" =~ ^\[vars\.([a-zA-Z_][a-zA-Z0-9_.]*)\]$ ]]; then
    in_vars=true
    current_prefix="${BASH_REMATCH[1]}."
  elif [[ "$line" =~ ^\[.*\]$ ]]; then
    in_vars=false
  elif $in_vars && [[ "$line" =~ ^([a-zA-Z_][a-zA-Z0-9_]*)\ *=\ *\"(.*)\"$ ]]; then
    var_keys+=("${current_prefix}${BASH_REMATCH[1]}")
    var_values+=("${BASH_REMATCH[2]}")
  fi
done < "$AGENTS_DIR/config.toml"

# Render template: replace {{var}} patterns with values from config.
# When an agent name is provided, agent-specific vars take priority.
# E.g. with agent "claude", {{coauthor}} resolves to the value for key "coauthor.claude".
render() {
  local content agent="${2:-}"
  content=$(<"$1")

  local i
  if [[ -n "$agent" ]]; then
    for (( i=0; i<${#var_keys[@]}; i++ )); do
      local key="${var_keys[$i]}"
      if [[ "$key" == *".$agent" ]]; then
        local base_key="${key%."$agent"}"
        content="${content//\{\{$base_key\}\}/${var_values[$i]}}"
      fi
    done
  fi

  for (( i=0; i<${#var_keys[@]}; i++ )); do
    content="${content//\{\{${var_keys[$i]}\}\}/${var_values[$i]}}"
  done
  printf '%s' "$content"
}

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

# Sync a rendered file to a destination, or check it matches
sync_file() {
  local src="$1" dest="$2" agent="${3:-}"
  local rendered
  rendered="$(render "$src" "$agent")"

  if $check_mode; then
    if [[ ! -f "$dest" ]]; then
      echo "MISSING: $dest" >&2
      return 1
    fi
    local existing
    existing=$(<"$dest")
    if [[ "$rendered" != "$existing" ]]; then
      echo "OUT OF SYNC: $dest" >&2
      return 1
    fi
  else
    mkdir -p "$(dirname "$dest")"
    printf '%s' "$rendered" > "$dest"
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
    if ! sync_file "$src" "$dest" "$target"; then
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
