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

[[ $# == 2 ]] || die 'usage: preflight.sh SHA BUNDLE_DIR'
sha="$1"
bundle="$2"
require_sha "$sha"

for command_name in node npm nginx pm2 pg_dump pg_restore psql realpath sha256sum flock openssl ss curl sudo; do
  check "command:$command_name" command -v "$command_name"
done

load_release_config
node_bin="$(approved_node_bin)"
owner="$(config_owner)"

check os test "$(uname -s)" = Linux
check node22 bash -c '[[ "$("$1" -p "process.versions.node.split(`.`)[0]")" == 22 ]]' _ "$node_bin"
check npm10 bash -c '[[ "$(npm -v | cut -d. -f1)" == 10 ]]'
check profile bash -c '[[ "$1" == pilot || "$1" == production ]]' _ "${DX_REWORK_PROFILE:-}"
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
check nginx-rendered bash -c '! grep -Eq "__[A-Z0-9_]+__|staging-api\.dxerp\.org\.cn" "$1"' _ "$nginx_conf"
check nginx-maintenance-gate grep -Fq '/opt/dx-rework/shared/release-switch.lock' "$nginx_conf"
check nginx-query-free-redirect bash -c '[[ $(grep -Fc "access_log /opt/dx-rework/logs/nginx-access.log dx_rework_query_free;" "$1") -ge 2 ]]' _ "$nginx_conf"
check domain bash -c '[[ "$1" =~ ^[A-Za-z0-9.-]+$ && "$1" != staging-api.dxerp.org.cn ]]' _ "$DX_REWORK_SERVER_NAME"
check smoke-origin bash -c '[[ "$1" == "https://$2" ]]' _ "$DX_REWORK_SMOKE_URL" "$DX_REWORK_SERVER_NAME"

for file in "$DX_REWORK_TLS_CERT" "$DX_REWORK_TLS_KEY"; do
  check "tls-file:$file" bash -c '[[ -f "$1" && ! -L "$1" && ! "$1" -ef /dev/null ]]' _ "$file"
done
check tls-expiry openssl x509 -checkend 86400 -noout -in "$DX_REWORK_TLS_CERT"
check tls-host openssl x509 -checkhost "$DX_REWORK_SERVER_NAME" -noout -in "$DX_REWORK_TLS_CERT"
check tls-key-mode bash -c 'mode=$(stat -c %a "$1"); (( (8#$mode & 0077) == 0 ))' _ "$DX_REWORK_TLS_KEY"
check nginx-test sudo -n nginx -t
check nginx-loaded bash -c '
  count=$(sudo -n nginx -T 2>&1 | grep -Ec "^[[:space:]]*server_name[[:space:]]+$1;")
  [[ "$count" == 2 ]]
' _ "$DX_REWORK_SERVER_NAME"

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
