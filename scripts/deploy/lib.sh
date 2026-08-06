#!/usr/bin/env bash
# Shared fail-closed primitives for PR-17 deployment tools.
set -euo pipefail

DX_ROOT="${DX_REWORK_ROOT:-/opt/dx-rework}"

die() {
  safe_log fail "$1"
  exit "${2:-64}"
}

redact() {
  sed -E 's#(postgres(ql)?://)[^/@[:space:]]+(:[^/@[:space:]]+)?@#\1[REDACTED]@#g;s#([?&](token|secret|signature|x-amz-signature|session)=)[^&[:space:]]+#\1[REDACTED]#Ig;s#(Authorization|token|secret|session)[=:][^, }[:space:]]+#\1=[REDACTED]#Ig' <<<"$*" |
    tr -d '\000-\010\013\014\016-\037'
}

safe_log() {
  local status="$1" message
  shift
  message="$(redact "$*")"
  printf '{"status":"%s","message":"%s"}\n' "$status" "$(printf %s "$message" | sed 's/\\/\\\\/g;s/"/\\"/g')"
}

require_sha() {
  [[ "${1:-}" =~ ^[0-9a-f]{40}$ ]] || die 'invalid 40-character lowercase Git SHA'
}

reject_unsafe_value() {
  local value="${1-}"
  [[ -n "$value" && "$value" != *$'\n'* && "$value" != *$'\r'* && "$value" != *'..'* && "$value" != *'*'* && "$value" != *'?'* && "$value" != *'['* && ! "$value" =~ [[:cntrl:]] ]] ||
    die 'unsafe empty/control/glob/traversal value'
}

canonical_missing() {
  realpath -m -- "$1"
}

assert_safe_path() {
  local path="${1:-}" root="${2:-$DX_ROOT}" resolved parent
  reject_unsafe_value "$path"
  [[ "$path" == /* ]] || die 'absolute path required'
  resolved="$(canonical_missing "$path")"
  [[ "$resolved" == "$root" || "$resolved" == "$root/"* ]] || die 'path outside allowed boundary'
  [[ "$resolved" != /opt/daxing-erp* && "$resolved" != /opt/daxing-sample* ]] || die 'ERP/sample path forbidden'
  parent="$resolved"
  while [[ "$parent" != / && "$parent" != "$root" ]]; do
    [[ ! -L "$parent" ]] || die 'symlink target or parent forbidden'
    parent="$(dirname "$parent")"
  done
  [[ ! -L "$resolved" ]] || die 'symlink target forbidden'
  printf '%s\n' "$resolved"
}

require_command() {
  command -v "$1" >/dev/null || die "required command unavailable: $1"
}

require_mode() {
  [[ "$(stat -c '%a' "$1")" == "$2" ]] || die "unsafe permissions for $1"
}

verify_sums() {
  local dir="$1"
  (cd "$dir" && sha256sum --check --strict SHA256SUMS >/dev/null) || die 'checksum verification failed'
}

approved_node_bin() {
  local candidate="${DX_REWORK_NODE_BIN:-}"
  if [[ -z "$candidate" ]]; then
    candidate="$(command -v node || true)"
    [[ -n "$candidate" && -x "$candidate" ]] || die 'Node executable unavailable'
  else
    [[ "$candidate" == /* && -f "$candidate" && ! -L "$candidate" && -x "$candidate" ]] ||
      die 'approved Node executable unavailable or unsafe'
  fi
  printf '%s\n' "$candidate"
}

node_exec() {
  local node_bin
  node_bin="$(approved_node_bin)"
  "$node_bin" "$@"
}

acquire_lock() {
  local file inherited="${DX_REWORK_LOCK_FD:-}"
  file="$(assert_safe_path "$1")"
  mkdir -p "$(dirname "$file")"
  [[ ! -L "$file" ]] || die 'symlink lock forbidden'

  if [[ "$inherited" =~ ^[0-9]+$ && -e "/proc/$$/fd/$inherited" ]]; then
    [[ "$(readlink -f "/proc/$$/fd/$inherited")" == "$(realpath -m "$file")" ]] ||
      die 'inherited deployment lock does not match requested lock'
    return
  fi

  exec 9>"$file"
  flock -n 9 || die 'deployment lock is held'
  export DX_REWORK_LOCK_FD=9
}

atomic_link() {
  local target="$1" link="$2" tmp
  tmp="${link}.tmp.$$"
  assert_safe_path "$target" >/dev/null
  assert_safe_path "$link" >/dev/null
  ln -s "$target" "$tmp"
  mv -Tf "$tmp" "$link"
}

manifest_field() {
  node_exec -e 'const m=require(process.argv[1]); const v=process.argv[2].split(".").reduce((o,k)=>o?.[k],m); if(v===undefined||v===null)process.exit(2); process.stdout.write(String(v))' "$1" "$2"
}

assert_release() {
  local dir sha root="${3:-$DX_ROOT}"
  dir="$(assert_safe_path "$1" "$root")"
  sha="$2"
  require_sha "$sha"
  [[ -d "$dir" && ! -L "$dir" && -f "$dir/release-manifest.json" && -f "$dir/SHA256SUMS" ]] ||
    die 'release is not registered'
  [[ "$(manifest_field "$dir/release-manifest.json" gitSha)" == "$sha" ]] || die 'manifest SHA mismatch'
  verify_sums "$dir"
}

# Parse a 0600 KEY=value file without executing it. Every key must belong to
# the full allowlist. Only keys in the optional selected list are exported.
load_env_file() {
  local file="$1" expected_owner="$2" allowed=" $3 " selected=" ${4:-$3} " line key value owner
  [[ -f "$file" && ! -L "$file" ]] || die "environment file must be a regular non-symlink: $file"
  require_mode "$file" 600
  owner="$(stat -c %U "$file")"
  [[ "$owner" == "$expected_owner" ]] || die "environment file has wrong owner: $file"
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" || "$line" == \#* ]] && continue
    [[ "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]] || die 'invalid environment line'
    key="${line%%=*}"
    value="${line#*=}"
    [[ "$allowed" == *" $key "* ]] || die "environment key is not allowed: $key"
    [[ "$value" != *$'\r'* && ! "$value" =~ [[:cntrl:]] ]] || die "environment value contains control characters: $key"
    case "$key" in
      NODE_OPTIONS|BASH_ENV|ENV|LD_PRELOAD|LD_LIBRARY_PATH|DX_REWORK_TEST_*)
        die "interpreter/test control variable forbidden: $key"
        ;;
    esac
    if [[ "$selected" == *" $key "* ]]; then
      printf -v "$key" %s "$value"
      export "$key"
    fi
  done < "$file"
}

DX_REWORK_APP_ENV_KEYS='DATABASE_URL LOG_LEVEL DINGTALK_CORP_ID DINGTALK_H5_APP_KEY DINGTALK_H5_APP_SECRET DINGTALK_WEB_CLIENT_ID DINGTALK_WEB_CLIENT_SECRET DINGTALK_QR_REDIRECT_URI APP_BASE_PATH SESSION_SECRET SESSION_TTL_SECONDS TODO_RUNTIME_ENABLED TODO_RUNTIME_ACTOR_ID TODO_DELIVERY_INTERVAL_MS TODO_TIMING_INTERVAL_MS OSS_REGION OSS_ENDPOINT OSS_BUCKET OSS_ACCESS_KEY_ID OSS_ACCESS_KEY_SECRET OSS_PRIVATE_PREFIX OSS_SIGNED_URL_TTL_SECONDS OSS_MAX_UPLOAD_BYTES'
DX_REWORK_DEPLOY_ENV_KEYS='DX_REWORK_NODE_BIN DX_REWORK_SERVER_NAME DX_REWORK_TLS_CERT DX_REWORK_TLS_KEY DX_REWORK_NGINX_CONFIG DX_REWORK_PROFILE'
DX_REWORK_RESTORE_ENV_KEYS='DX_REWORK_RESTORE_DATABASE_URL DX_REWORK_APPROVED_TARGET_FINGERPRINT DX_REWORK_APPROVED_TARGET_DATABASE'

config_owner() {
  local actual expected
  actual="$(id -un)"
  expected="${DX_REWORK_EXPECTED_OWNER:-$actual}"
  [[ "$expected" == "$actual" ]] || die 'expected configuration owner must equal the active deployment user'
  printf '%s\n' "$actual"
}

load_app_config() {
  load_env_file "${DX_REWORK_APP_ENV_FILE:-$DX_ROOT/shared/.env}" "$(config_owner)" "$DX_REWORK_APP_ENV_KEYS"
}

load_deploy_config() {
  load_env_file "${DX_REWORK_DEPLOY_ENV_FILE:-$DX_ROOT/shared/deploy.env}" "$(config_owner)" "$DX_REWORK_DEPLOY_ENV_KEYS"
}

load_node_config() {
  load_env_file "${DX_REWORK_DEPLOY_ENV_FILE:-$DX_ROOT/shared/deploy.env}" "$(config_owner)" "$DX_REWORK_DEPLOY_ENV_KEYS" 'DX_REWORK_NODE_BIN'
}

load_restore_config() {
  load_env_file "${DX_REWORK_RESTORE_ENV_FILE:-$DX_ROOT/shared/restore.env}" "$(config_owner)" "$DX_REWORK_RESTORE_ENV_KEYS"
}

load_release_config() {
  load_app_config
  load_deploy_config
  [[ "${DX_REWORK_SERVER_NAME:-}" =~ ^[A-Za-z0-9.-]+$ ]] || die 'invalid release server name'
  export DX_REWORK_SMOKE_URL="https://${DX_REWORK_SERVER_NAME}"
}
