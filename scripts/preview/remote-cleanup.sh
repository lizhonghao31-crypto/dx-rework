#!/usr/bin/env bash
set -euo pipefail
readonly preview_root=/opt/dx-rework/previews
readonly pr_number="${1:-}"
[[ "$pr_number" =~ ^[1-9][0-9]*$ ]] || { echo "invalid PR number" >&2; exit 64; }
readonly target="${preview_root}/pr-${pr_number}"
[[ "$target" =~ ^/opt/dx-rework/previews/pr-[1-9][0-9]*$ ]] || { echo "unsafe cleanup target" >&2; exit 65; }
[[ -d "$preview_root" && ! -L "$preview_root" ]] || { echo "preview root unavailable or symlink" >&2; exit 66; }
rm -rf -- "$target"
