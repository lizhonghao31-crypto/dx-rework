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

ensure_static_alias() {
  local alias_path="$1" expected_target="$2"
  if [[ -L "$alias_path" ]]; then
    [[ "$(readlink "$alias_path")" == "$expected_target" ]] || die "release alias target mismatch: $alias_path"
  elif [[ -e "$alias_path" ]]; then
    die "release alias must be a symlink: $alias_path"
  else
    ln -s "$expected_target" "$alias_path"
  fi
}

ensure_generation() {
  local sha="$1" generations generation tmp api web
  require_sha "$sha"
  generations="$DX_ROOT/generations"
  generation="$generations/$sha"
  api="$DX_ROOT/releases/$sha"
  web="$DX_ROOT/frontend/releases/$sha"
  assert_release "$api" "$sha"
  assert_release "$web" "$sha"
  mkdir -p "$generations"
  [[ -d "$generations" && ! -L "$generations" ]] || die 'generations root must be a real directory'

  if [[ ! -e "$generation" ]]; then
    tmp="${generation}.tmp.$$"
    mkdir -m 0755 "$tmp"
    ln -s "$api" "$tmp/api"
    ln -s "$web" "$tmp/frontend"
    mv "$tmp" "$generation"
  fi

  [[ -d "$generation" && ! -L "$generation" ]] || die 'generation must be a real directory'
  [[ -L "$generation/api" && "$(readlink -f "$generation/api")" == "$api" ]] || die 'generation API target mismatch'
  [[ -L "$generation/frontend" && "$(readlink -f "$generation/frontend")" == "$web" ]] || die 'generation frontend target mismatch'
  printf '%s\n' "$generation"
}

ensure_active_aliases() {
  mkdir -p "$DX_ROOT/frontend"
  ensure_static_alias "$DX_ROOT/current" "$DX_ROOT/active/api"
  ensure_static_alias "$DX_ROOT/frontend/current" "$DX_ROOT/active/frontend"
}

current_generation_sha() {
  local active="$DX_ROOT/active" generation sha
  if [[ -L "$active" ]]; then
    generation="$(readlink -f "$active" 2>/dev/null || true)"
    [[ -d "$generation" && ! -L "$generation" ]] || die 'active generation link is broken'
    sha="$(basename "$generation")"
    require_sha "$sha"
    [[ "$generation" == "$DX_ROOT/generations/$sha" ]] || die 'active generation is outside the generations root'
    ensure_generation "$sha" >/dev/null
    printf '%s\n' "$sha"
    return 0
  fi
  [[ ! -e "$active" ]] || die 'active generation must be a symlink'
  return 1
}

assert_active_release() {
  local expected_sha="$1" active_sha
  require_sha "$expected_sha"
  [[ -L "$DX_ROOT/current" && "$(readlink "$DX_ROOT/current")" == "$DX_ROOT/active/api" ]] ||
    die 'API current alias is not bound to the active generation'
  [[ -L "$DX_ROOT/frontend/current" && "$(readlink "$DX_ROOT/frontend/current")" == "$DX_ROOT/active/frontend" ]] ||
    die 'frontend current alias is not bound to the active generation'
  active_sha="$(current_generation_sha)" || die 'no active generation'
  [[ "$active_sha" == "$expected_sha" ]] || die 'active generation SHA mismatch'
  [[ "$(readlink -f "$DX_ROOT/current")" == "$DX_ROOT/releases/$expected_sha" ]] || die 'active API release mismatch'
  [[ "$(readlink -f "$DX_ROOT/frontend/current")" == "$DX_ROOT/frontend/releases/$expected_sha" ]] ||
    die 'active frontend release mismatch'
}

release_switch_flag() {
  printf '%s\n' "$DX_ROOT/shared/release-switch.lock"
}

enter_release_maintenance() {
  local flag
  flag="$(release_switch_flag)"
  [[ -d "$DX_ROOT/shared" && ! -L "$DX_ROOT/shared" ]] || die 'shared directory unavailable for release maintenance'
  [[ ! -L "$flag" ]] || die 'release maintenance flag must not be a symlink'
  if [[ ! -e "$flag" ]]; then
    (set -o noclobber; : > "$flag") 2>/dev/null || die 'unable to create release maintenance flag'
    chmod 0600 "$flag"
  fi
}

leave_release_maintenance() {
  local flag
  flag="$(release_switch_flag)"
  [[ ! -L "$flag" ]] || die 'release maintenance flag must not be a symlink'
  rm -f "$flag"
}

database_states_equal() {
  node_exec -e '
const pick=x=>{const v=JSON.parse(x);return {count:v.count,version:v.version??null,checksum:v.checksum??null}};
process.exit(JSON.stringify(pick(process.argv[1]))===JSON.stringify(pick(process.argv[2]))?0:1);
' "$1" "$2"
}

# Parse a 0600 KEY=value file without executing it. Every key must belong to
# the full allowlist. Only keys in the optional selected list are exported.
load_env_file() {
  local file="$1" expected_owner="$2" allowed=" $3 " selected=" ${4:-$3} " line key value owner selected_key
  [[ -f "$file" && ! -L "$file" ]] || die "environment file must be a regular non-symlink: $file"
  require_mode "$file" 600
  owner="$(stat -c %U "$file")"
  [[ "$owner" == "$expected_owner" ]] || die "environment file has wrong owner: $file"

  # Configuration files are authoritative. Clear every selected key first so
  # an omitted key cannot silently inherit stale credentials or approvals.
  for selected_key in $selected; do
    unset "$selected_key"
  done

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

DX_REWORK_APP_ENV_KEYS='DATABASE_URL LOG_LEVEL DINGTALK_CORP_ID DINGTALK_H5_APP_KEY DINGTALK_H5_APP_SECRET DINGTALK_H5_AGENT_ID DINGTALK_WEB_CLIENT_ID DINGTALK_WEB_CLIENT_SECRET DINGTALK_QR_REDIRECT_URI APP_BASE_PATH SESSION_SECRET SESSION_TTL_SECONDS ROOT_DINGTALK_USER_ID OWNER_BOOTSTRAP_DINGTALK_USER_ID OWNER_BOOTSTRAP_SECRET TODO_RUNTIME_ENABLED TODO_DELIVERY_ENABLED TODO_TIMING_ENABLED TODO_PUBLIC_BASE_URL TODO_RUNTIME_ACTOR_ID TODO_DELIVERY_INTERVAL_MS TODO_TIMING_INTERVAL_MS OSS_REGION OSS_ENDPOINT OSS_BUCKET OSS_ACCESS_KEY_ID OSS_ACCESS_KEY_SECRET OSS_PRIVATE_PREFIX OSS_SIGNED_URL_TTL_SECONDS OSS_MAX_UPLOAD_BYTES INSPECTION_IMAGE_PROVIDER OPENAI_API_KEY OPENAI_VISION_MODEL DASHSCOPE_API_KEY DASHSCOPE_BASE_URL DASHSCOPE_VISION_MODEL'
DX_REWORK_DEPLOY_ENV_KEYS='DX_REWORK_NODE_BIN DX_REWORK_SERVER_NAME DX_REWORK_TLS_CERT DX_REWORK_TLS_KEY DX_REWORK_NGINX_CONFIG DX_REWORK_NGINX_MODE DX_REWORK_PROFILE'
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
  case "${DX_REWORK_NGINX_MODE:-}" in
    shared_path)
      [[ "${APP_BASE_PATH:-}" == /rework/ ]] || die 'shared_path requires APP_BASE_PATH=/rework/'
      ;;
    dedicated_vhost)
      ;;
    *)
      die 'DX_REWORK_NGINX_MODE must be shared_path or dedicated_vhost'
      ;;
  esac
  export DX_REWORK_SMOKE_ORIGIN="https://${DX_REWORK_SERVER_NAME}"
  if [[ "$DX_REWORK_NGINX_MODE" == shared_path ]]; then
    export DX_REWORK_SMOKE_WEB_URL="${DX_REWORK_SMOKE_ORIGIN}/rework"
    export DX_REWORK_SMOKE_API_URL="${DX_REWORK_SMOKE_ORIGIN}/rework/api"
  else
    export DX_REWORK_SMOKE_WEB_URL="$DX_REWORK_SMOKE_ORIGIN"
    export DX_REWORK_SMOKE_API_URL="$DX_REWORK_SMOKE_ORIGIN"
  fi
  # Backward-compatible alias for scripts that only need the public Web base.
  export DX_REWORK_SMOKE_URL="$DX_REWORK_SMOKE_WEB_URL"
}
