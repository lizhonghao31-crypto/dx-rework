#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/lib.sh"
[[ $# == 3 ]] || die 'usage: build-release.sh SHA ISO_BUILD_TIME OUTPUT_DIR'
sha="$1"; build_time="$2"; out="$(assert_safe_path "$3" "${DX_REWORK_BUILD_ROOT:-$PWD/.pr17-build}")"
require_sha "$sha"; date -d "$build_time" -u +%FT%TZ >/dev/null || die 'invalid ISO build time'
[[ "$(git rev-parse HEAD)" == "$sha" ]] || die 'Head mismatch'; [[ -z "$(git status --porcelain)" ]] || die 'dirty worktree'; [[ ! -e "$out" && ! -L "$out" ]] || die 'output already exists'
[[ "$(node -p 'process.versions.node.split(`.`)[0]')" == 22 ]] || die 'Node 22 required'; [[ "$(npm --version|cut -d. -f1)" == 10 ]] || die 'npm 10 required'
npm ci; npm run build
"$(dirname "$0")/package-release.sh" "$sha" "$build_time" "$out"
"$(dirname "$0")/verify-runtime.sh" "$out/api"
