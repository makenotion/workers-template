#!/usr/bin/env bash

set -euo pipefail

readonly REPOSITORY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly TEMPLATE_ROOT="$REPOSITORY_ROOT/template"
readonly CANONICAL_INSTRUCTIONS="$TEMPLATE_ROOT/.agents/INSTRUCTIONS.md"
readonly CANONICAL_SKILLS="$TEMPLATE_ROOT/.agents/skills"
readonly AGENTS_INSTRUCTIONS="$TEMPLATE_ROOT/AGENTS.md"
readonly CLAUDE_INSTRUCTIONS="$TEMPLATE_ROOT/CLAUDE.md"
readonly CLAUDE_SKILLS="$TEMPLATE_ROOT/.claude/skills"

usage() {
	printf 'Usage: %s [--check]\n' "$0" >&2
}

file_hash() {
	shasum -a 256 "$1" | awk '{ print $1 }'
}

write_tree_manifest() {
	local directory="$1"
	local output="$2"

	(
		cd "$directory"
		find . -type f -print | LC_ALL=C sort | while IFS= read -r path; do
			printf '%s  %s\n' "$(file_hash "$path")" "$path"
		done
	) >"$output"
}

check_file_copy() {
	local canonical="$1"
	local copy="$2"
	local canonical_hash
	local copy_hash

	if [[ ! -f "$copy" || -L "$copy" ]]; then
		printf 'Agent file copy is missing or is not a regular file: %s\n' "$copy" >&2
		return 1
	fi

	canonical_hash="$(file_hash "$canonical")"
	copy_hash="$(file_hash "$copy")"
	if [[ "$canonical_hash" != "$copy_hash" ]]; then
		printf 'Agent file copy is out of date: %s\n' "$copy" >&2
		printf '  expected sha256: %s\n' "$canonical_hash" >&2
		printf '  actual sha256:   %s\n' "$copy_hash" >&2
		return 1
	fi
}

check_tree_copy() {
	local canonical="$1"
	local copy="$2"
	local temporary_directory="$3"
	local canonical_manifest="$temporary_directory/canonical.manifest"
	local copy_manifest="$temporary_directory/copy.manifest"
	local canonical_hash
	local copy_hash

	if [[ ! -d "$copy" || -L "$copy" ]]; then
		printf 'Agent skills copy is missing or is not a directory: %s\n' "$copy" >&2
		return 1
	fi

	if find "$copy" -type l -print -quit | grep -q .; then
		printf 'Agent skills copy contains a symlink: %s\n' "$copy" >&2
		return 1
	fi

	write_tree_manifest "$canonical" "$canonical_manifest"
	write_tree_manifest "$copy" "$copy_manifest"
	canonical_hash="$(file_hash "$canonical_manifest")"
	copy_hash="$(file_hash "$copy_manifest")"
	if [[ "$canonical_hash" != "$copy_hash" ]]; then
		printf 'Agent skills copy is out of date: %s\n' "$copy" >&2
		printf '  expected manifest sha256: %s\n' "$canonical_hash" >&2
		printf '  actual manifest sha256:   %s\n' "$copy_hash" >&2
		diff -u "$canonical_manifest" "$copy_manifest" >&2 || true
		return 1
	fi
}

check_copies() {
	local temporary_directory
	local status=0

	temporary_directory="$(mktemp -d "${TMPDIR:-/tmp}/workers-template-agent-files.XXXXXX")"

	check_file_copy "$CANONICAL_INSTRUCTIONS" "$AGENTS_INSTRUCTIONS" || status=1
	check_file_copy "$CANONICAL_INSTRUCTIONS" "$CLAUDE_INSTRUCTIONS" || status=1
	check_tree_copy "$CANONICAL_SKILLS" "$CLAUDE_SKILLS" "$temporary_directory" || status=1
	rm -rf "$temporary_directory"

	if [[ "$status" -ne 0 ]]; then
		printf 'Run `mise run fix:agents` to refresh generated agent files.\n' >&2
		return "$status"
	fi

	printf 'Agent file copies are up to date.\n'
}

sync_copies() {
	cp "$CANONICAL_INSTRUCTIONS" "$AGENTS_INSTRUCTIONS"
	cp "$CANONICAL_INSTRUCTIONS" "$CLAUDE_INSTRUCTIONS"
	rm -rf "$CLAUDE_SKILLS"
	mkdir -p "$CLAUDE_SKILLS"
	cp -R "$CANONICAL_SKILLS/." "$CLAUDE_SKILLS/"
	check_copies
}

case "${1:-}" in
	"")
		sync_copies
		;;
	--check)
		check_copies
		;;
	*)
		usage
		exit 2
		;;
esac
