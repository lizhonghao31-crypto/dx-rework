#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/lib.sh"

fail=0
check() {
  local name="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    safe_log pass "$name"
  else
    safe_log fail "$name"
    fail=1
  fi
}

extract_shared_block() {
  local file="$1"
  awk '
    /# DX_REWORK_SHARED_PATHS_BEGIN/ {
      if (seen_begin++) exit 2
      emit=1
    }
    emit { print }
    /# DX_REWORK_SHARED_PATHS_END/ {
      if (!emit || seen_end++) exit 2
      emit=0
    }
    END { if (seen_begin != 1 || seen_end != 1 || emit) exit 1 }
  ' "$file"
}

validate_shared_config() {
  local conf="$1" block lock_re lock_count proxy_count root_count rework_location_re rework_location_count frontend_re
  [[ "${APP_BASE_PATH:-}" == /rework/ ]] || return 1
  [[ "${DX_REWORK_SERVER_NAME:-}" =~ ^[A-Za-z0-9.-]+$ ]] || return 1
  ! grep -Eq '__[A-Z0-9_]+__' "$conf" || return 1
  grep -Eq "^[[:space:]]*server_name[[:space:]]+${DX_REWORK_SERVER_NAME//./\\.}([[:space:]]|;)" "$conf" || return 1

  block="$(extract_shared_block "$conf")" || return 1
  ! grep -Eq '^[[:space:]]*(server[[:space:]]*\{|listen[[:space:]]|server_name[[:space:]]|ssl_certificate(_key)?[[:space:]])' <<<"$block" || return 1
  ! grep -Eq 'location[[:space:]]+(=|\^~)?[[:space:]]+/(health|version|api/|assets/|login([[:space:]]|\{)|[[:space:]]*\{)' <<<"$block" || return 1
  ! grep -Fq 'location / {' <<<"$block" || return 1
  ! grep -Eq '/opt/daxing-(erp|sample)' <<<"$block" || return 1

  for required in \
    'location = /rework {' \
    'location = /rework/auth/qr/relay {' \
    'location = /rework/api/auth/qr/callback {' \
    'location ^~ /rework/api/ {' \
    'location ^~ /rework/assets/ {' \
    'location ^~ /rework/ {'; do
    [[ "$(grep -Fc "$required" <<<"$block")" == 1 ]] || return 1
  done

  rework_location_re='^[[:space:]]*location[[:space:]]+(=|\^~)?[[:space:]]*/rework([[:space:]]|\{|/)'
  rework_location_count="$(grep -Ec "$rework_location_re" <<<"$block")"
  [[ "$rework_location_count" == 6 ]] || return 1
  [[ "$(grep -Ec "$rework_location_re" "$conf")" == "$rework_location_count" ]] || return 1

  lock_re='^[[:space:]]*if[[:space:]]+\(-f[[:space:]]+/opt/dx-rework/shared/release-switch\.lock\)[[:space:]]*\{'
  lock_count="$(grep -Ec "$lock_re" <<<"$block")"
  [[ "$lock_count" == 6 ]] || return 1
  [[ "$(grep -Ec "$lock_re" "$conf")" == "$lock_count" ]] || return 1

  proxy_count="$(grep -Ec '^[[:space:]]*proxy_pass[[:space:]]+http://127\.0\.0\.1:3201(/auth/qr/callback|/);$' <<<"$block")"
  [[ "$proxy_count" == 2 ]] || return 1
  [[ "$(grep -Ec '^[[:space:]]*proxy_pass[[:space:]]+' <<<"$block")" == "$proxy_count" ]] || return 1
  [[ "$(grep -Ec '^[[:space:]]*proxy_pass[[:space:]]+http://127\.0\.0\.1:3201' "$conf")" == "$proxy_count" ]] || return 1

  frontend_re='^[[:space:]]*(root|alias)[[:space:]]+/opt/dx-rework/frontend/current(/[^;]*)?;'
  root_count="$(grep -Ec "$frontend_re" <<<"$block")"
  [[ "$root_count" == 3 ]] || return 1
  [[ "$(grep -Ec "$frontend_re" "$conf")" == "$root_count" ]] || return 1
  [[ "$(grep -Fc 'root /opt/dx-rework/frontend/current;' <<<"$block")" == 2 ]] || return 1
  grep -Fq 'alias /opt/dx-rework/frontend/current/index.html;' <<<"$block" || return 1
  grep -Fq 'try_files $uri =404;' <<<"$block" || return 1
  grep -Fq 'try_files $uri $uri/ /rework/index.html;' <<<"$block" || return 1
  ! grep -Fq 'try_files $uri $uri/ /index.html;' <<<"$block" || return 1

  grep -A5 -F 'location = /rework/auth/qr/relay {' <<<"$block" | grep -Fq 'access_log off;' || return 1
  grep -A5 -F 'location = /rework/auth/qr/relay {' <<<"$block" | grep -Fq 'error_log /dev/null emerg;' || return 1
  grep -A6 -F 'location = /rework/api/auth/qr/callback {' <<<"$block" | grep -Fq 'access_log off;' || return 1
  grep -A6 -F 'location = /rework/api/auth/qr/callback {' <<<"$block" | grep -Fq 'error_log /dev/null emerg;' || return 1
  [[ "$(grep -Fc 'access_log /opt/dx-rework/logs/nginx-access.log dx_rework_query_free;' <<<"$block")" -ge 4 ]] || return 1
}

validate_shared_loaded() (
  local conf="$1" dump_file file_block dump_block
  dump_file="$(mktemp)"
  trap 'rm -f "$dump_file"' EXIT
  sudo -n nginx -T >"$dump_file" 2>&1 || return 1
  grep -Eq "^[[:space:]]*server_name[[:space:]]+${DX_REWORK_SERVER_NAME//./\\.}([[:space:]]|;)" "$dump_file" || return 1
  [[ "$(grep -Fc '# DX_REWORK_SHARED_PATHS_BEGIN' "$dump_file")" == 1 ]] || return 1
  [[ "$(grep -Fc '# DX_REWORK_SHARED_PATHS_END' "$dump_file")" == 1 ]] || return 1
  file_block="$(extract_shared_block "$conf")" || return 1
  dump_block="$(extract_shared_block "$dump_file")" || return 1
  [[ "$file_block" == "$dump_block" ]] || return 1
  grep -Eq '^[[:space:]]*log_format[[:space:]]+dx_rework_query_free[[:space:]]' "$dump_file" || return 1
)

validate_dedicated_config() {
  local conf="$1"
  ! grep -Eq '__[A-Z0-9_]+__|staging-api\.dxerp\.org\.cn' "$conf" || return 1
  grep -Fq '/opt/dx-rework/shared/release-switch.lock' "$conf" || return 1
  [[ "$(grep -Fc 'access_log /opt/dx-rework/logs/nginx-access.log dx_rework_query_free;' "$conf")" -ge 2 ]] || return 1
  [[ "$DX_REWORK_SERVER_NAME" != staging-api.dxerp.org.cn ]] || return 1
}

validate_dedicated_loaded() {
  local count
  count="$(sudo -n nginx -T 2>&1 | grep -Ec "^[[:space:]]*server_name[[:space:]]+${DX_REWORK_SERVER_NAME//./\\.};")"
  [[ "$count" == 2 ]]
}

[[ $# == 2 ]] || die 'usage: preflight.sh SHA BUNDLE_DIR'
sha="$1"
bundle="$2"
require_sha "$sha"

for command_name in node npm nginx pm2 realpath sha256sum flock openssl ss curl sudo awk; do
  check "command:$command_name" command -v "$command_name"
done

load_release_config
node_bin="$(approved_node_bin)"
owner="$(config_owner)"

check os test "$(uname -s)" = Linux
check node22 bash -c '[[ "$("$1" -p "process.versions.node.split(`.`)[0]")" == 22 ]]' _ "$node_bin"
check npm10 bash -c '[[ "$(npm -v | cut -d. -f1)" == 10 ]]'
check profile bash -c '[[ "$1" == pilot || "$1" == production ]]' _ "${DX_REWORK_PROFILE:-}"
check nginx-mode bash -c '[[ "$1" == shared_path || "$1" == dedicated_vhost ]]' _ "$DX_REWORK_NGINX_MODE"
check memory bash -c '[[ $(awk "/MemAvailable/{print \$2}" /proc/meminfo) -ge ${DX_REWORK_MIN_MEMORY_KB:-262144} ]]'
check disk bash -c '[[ $(df -Pk "$1" | awk "NR==2{print \$4}") -ge ${DX_REWORK_MIN_DISK_KB:-1048576} ]]' _ "$DX_ROOT"
check root-boundary assert_safe_path "$DX_ROOT"
check maintenance-clear test ! -e "$(release_switch_flag)"

for directory in \
  "$DX_ROOT" \
  "$DX_ROOT/releases" \
  "$DX_ROOT/generations" \
  "$DX_ROOT/frontend" \
  "$DX_ROOT/frontend/releases" \
  "$DX_ROOT/shared" \
  "$DX_ROOT/logs" \
  "$DX_ROOT/backups" \
  "$DX_ROOT/evidence" \
  "$DX_ROOT/locks" \
  "$DX_ROOT/incoming"; do
  check "directory:$directory" bash -c '
    d="$1"; owner="$2"
    [[ -d "$d" && ! -L "$d" && "$(stat -c %U "$d")" == "$owner" ]]
    mode="$(stat -c %a "$d")"
    (( (8#$mode & 0022) == 0 ))
  ' _ "$directory" "$owner"
done

nginx_conf="${DX_REWORK_NGINX_CONFIG:-$DX_ROOT/shared/nginx.conf}"
check nginx-regular bash -c '[[ -f "$1" && ! -L "$1" ]]' _ "$nginx_conf"
check domain bash -c '[[ "$1" =~ ^[A-Za-z0-9.-]+$ ]]' _ "$DX_REWORK_SERVER_NAME"

if [[ "$DX_REWORK_NGINX_MODE" == shared_path ]]; then
  check shared-app-base test "$APP_BASE_PATH" = /rework/
  check shared-smoke-web test "$DX_REWORK_SMOKE_WEB_URL" = "https://${DX_REWORK_SERVER_NAME}/rework"
  check shared-smoke-api test "$DX_REWORK_SMOKE_API_URL" = "https://${DX_REWORK_SERVER_NAME}/rework/api"
  check nginx-shared-contract validate_shared_config "$nginx_conf"
else
  check dedicated-smoke-web test "$DX_REWORK_SMOKE_WEB_URL" = "https://${DX_REWORK_SERVER_NAME}"
  check dedicated-smoke-api test "$DX_REWORK_SMOKE_API_URL" = "https://${DX_REWORK_SERVER_NAME}"
  check nginx-dedicated-contract validate_dedicated_config "$nginx_conf"
fi

for file in "$DX_REWORK_TLS_CERT" "$DX_REWORK_TLS_KEY"; do
  check "tls-file:$file" bash -c '[[ -f "$1" && ! -L "$1" && ! "$1" -ef /dev/null ]]' _ "$file"
done
check tls-expiry openssl x509 -checkend 86400 -noout -in "$DX_REWORK_TLS_CERT"
check tls-host openssl x509 -checkhost "$DX_REWORK_SERVER_NAME" -noout -in "$DX_REWORK_TLS_CERT"
check tls-key-mode bash -c 'mode=$(stat -c %a "$1"); (( (8#$mode & 0077) == 0 ))' _ "$DX_REWORK_TLS_KEY"
check nginx-test sudo -n nginx -t
if [[ "$DX_REWORK_NGINX_MODE" == shared_path ]]; then
  check nginx-shared-loaded validate_shared_loaded "$nginx_conf"
else
  check nginx-dedicated-loaded validate_dedicated_loaded
fi

bundle="$(realpath "$bundle")"
check release-api assert_release "$bundle/api" "$sha" "$bundle"
check release-frontend assert_release "$bundle/frontend" "$sha" "$bundle"

validate_active_runtime() {
  local active_sha
  active_sha="$(current_generation_sha)" || return 1
  assert_active_release "$active_sha"
  pm2 jlist | "$node_bin" -e '
let s="";
process.stdin.on("data",d=>s+=d).on("end",()=>{
  const expected=process.argv[1];
  const apps=JSON.parse(s).filter(x=>x.name==="dx-rework-api"&&x.pm2_env?.status==="online");
  if(apps.length!==1||apps[0].pm2_env.pm_cwd!==expected)process.exit(1);
});
' "$DX_ROOT/current"
  curl -fsS http://127.0.0.1:3201/health/live >/dev/null
}

if (ss -ltn 2>/dev/null || true) | grep -qE ':3201[[:space:]]'; then
  check port-owner validate_active_runtime
else
  safe_log pass port3201-free
fi

check production-config env \
  NODE_ENV=production \
  HOST=127.0.0.1 \
  PORT=3201 \
  SERVICE_NAME=dx-rework-api \
  GIT_SHA="$sha" \
  BUILD_TIME="$(manifest_field "$bundle/api/release-manifest.json" buildTime)" \
  "$node_bin" -e 'import(process.argv[1]).then(m=>{m.loadConfig(process.env);process.stdout.write("configuration fields valid\n")})' \
  "$bundle/api/packages/config/dist/index.js"

(( fail == 0 )) || {
  safe_log blocked 'preflight blocked deployment'
  exit 1
}
