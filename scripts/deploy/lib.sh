#!/usr/bin/env bash
# Shared fail-closed primitives for PR-17 deployment tools.
set -euo pipefail
DX_ROOT="${DX_REWORK_ROOT:-/opt/dx-rework}"
die(){ safe_log fail "$1"; exit "${2:-64}"; }
redact(){ sed -E 's#(postgres(ql)?://)[^/@[:space:]]+(:[^/@[:space:]]+)?@#\1[REDACTED]@#g;s#([?&](token|secret|signature|x-amz-signature|session)=)[^&[:space:]]+#\1[REDACTED]#Ig;s#(Authorization|token|secret|session)[=:][^, }[:space:]]+#\1=[REDACTED]#Ig' <<<"$*" | tr -d '\000-\010\013\014\016-\037'; }
safe_log(){ local status="$1" message; shift; message="$(redact "$*")"; printf '{"status":"%s","message":"%s"}\n' "$status" "$(printf %s "$message"|sed 's/\\/\\\\/g;s/"/\\"/g')"; }
require_sha(){ [[ "${1:-}" =~ ^[0-9a-f]{40}$ ]] || die 'invalid 40-character lowercase Git SHA'; }
reject_unsafe_value(){ local v="${1-}"; [[ -n "$v" && "$v" != *$'\n'* && "$v" != *$'\r'* && "$v" != *'..'* && "$v" != *'*'* && "$v" != *'?'* && "$v" != *'['* && ! "$v" =~ [[:cntrl:]] ]] || die 'unsafe empty/control/glob/traversal value'; }
canonical_missing(){ realpath -m -- "$1"; }
assert_safe_path(){ local p="${1:-}" root="${2:-$DX_ROOT}" resolved parent; reject_unsafe_value "$p"; [[ "$p" == /* ]] || die 'absolute path required'; resolved="$(canonical_missing "$p")"; [[ "$resolved" == "$root" || "$resolved" == "$root/"* ]] || die 'path outside /opt/dx-rework boundary'; [[ "$resolved" != /opt/daxing-erp* && "$resolved" != /opt/daxing-sample* ]] || die 'ERP/sample path forbidden'; parent="$resolved"; while [[ "$parent" != / && "$parent" != "$root" ]]; do [[ ! -L "$parent" ]] || die 'symlink target or parent forbidden'; parent="$(dirname "$parent")"; done; [[ ! -L "$resolved" ]] || die 'symlink target forbidden'; printf '%s\n' "$resolved"; }
require_command(){ command -v "$1" >/dev/null || die "required command unavailable: $1"; }
require_mode(){ [[ "$(stat -c '%a' "$1")" == "$2" ]] || die "unsafe permissions for $1"; }
verify_sums(){ local dir="$1"; (cd "$dir" && sha256sum --check --strict SHA256SUMS >/dev/null) || die 'checksum verification failed'; }
acquire_lock(){ [[ "${DX_REWORK_LOCK_HELD:-false}" == true ]] && return; local file; file="$(assert_safe_path "$1")"; mkdir -p "$(dirname "$file")"; [[ ! -L "$file" ]] || die 'symlink lock forbidden'; exec 9>"$file"; flock -n 9 || die 'deployment lock is held'; export DX_REWORK_LOCK_HELD=true; }
atomic_link(){ local target="$1" link="$2" tmp="${link}.tmp.$$"; assert_safe_path "$target" >/dev/null; assert_safe_path "$link" >/dev/null; ln -s "$target" "$tmp"; mv -Tf "$tmp" "$link"; }
manifest_field(){ node -e 'const m=require(process.argv[1]); const v=process.argv[2].split(".").reduce((o,k)=>o?.[k],m); if(v===undefined||v===null)process.exit(2); process.stdout.write(String(v))' "$1" "$2"; }
assert_release(){ local dir sha root="${3:-$DX_ROOT}"; dir="$(assert_safe_path "$1" "$root")"; sha="$2"; require_sha "$sha"; [[ -d "$dir" && ! -L "$dir" && -f "$dir/release-manifest.json" && -f "$dir/SHA256SUMS" ]] || die 'release is not registered'; [[ "$(manifest_field "$dir/release-manifest.json" gitSha)" == "$sha" ]] || die 'manifest SHA mismatch'; verify_sums "$dir"; }
