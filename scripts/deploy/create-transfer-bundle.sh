#!/usr/bin/env bash
set -euo pipefail; source "$(dirname "$0")/lib.sh"; [[ $# == 2 ]] || die 'usage: create-transfer-bundle.sh BUNDLE OUTPUT_TAR'
bundle="$(realpath "$1")"; output="$2"; [[ -d "$bundle" && ! -L "$bundle" && ! -e "$output" ]] || die 'unsafe transfer paths'
find "$bundle" -type l -print -quit | grep -q . && die 'transfer bundle contains symlink'; find "$bundle" -type f \( -name '.env' -o -name '*key*' -o -name '*secret*' \) -print -quit | grep -q . && die 'transfer bundle contains forbidden secret-like file'
tar --sort=name --owner=0 --group=0 --numeric-owner --mtime='UTC 1970-01-01' -C "$(dirname "$bundle")" -czf "$output" "$(basename "$bundle")"; sha256sum "$(basename "$output")" > "$output.sha256"
