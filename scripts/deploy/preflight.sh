#!/usr/bin/env bash
set -euo pipefail; source "$(dirname "$0")/lib.sh"; fail=0
check(){ local name="$1"; shift; if "$@" >/dev/null 2>&1; then safe_log pass "$name"; else safe_log fail "$name"; fail=1; fi; }
[[ $# == 2 ]] || die 'usage: preflight.sh SHA BUNDLE_DIR'; sha="$1"; bundle="$2"; require_sha "$sha"
for c in node npm nginx pm2 pg_dump pg_restore psql realpath sha256sum flock openssl ss curl sudo; do check "command:$c" command -v "$c"; done
env_file="${DX_REWORK_APP_ENV_FILE:-$DX_ROOT/shared/.env}"; deploy_file="${DX_REWORK_DEPLOY_ENV_FILE:-$DX_ROOT/shared/deploy.env}"; owner="${DX_REWORK_DEPLOY_USER:-$(id -un)}"
check env-regular bash -c '[[ -f "$1" && ! -L "$1" ]]' _ "$env_file"; check env-mode require_mode "$env_file" 600; check deploy-env-regular bash -c '[[ -f "$1" && ! -L "$1" ]]' _ "$deploy_file"; check deploy-env-mode require_mode "$deploy_file" 600
load_env_file "$env_file" "$owner" "$DX_REWORK_APP_ENV_KEYS"; load_env_file "$deploy_file" "$owner" "$DX_REWORK_DEPLOY_ENV_KEYS"
check os test "$(uname -s)" = Linux; check node-bin bash -c '[[ "$1" == /* && -f "$1" && ! -L "$1" && -x "$1" && "$("$1" -p "process.versions.node.split(`.`)[0]")" == 22 ]]' _ "${DX_REWORK_NODE_BIN:-}"; check npm10 bash -c '[[ $(npm -v|cut -d. -f1) == 10 ]]'
check memory bash -c '[[ $(awk "/MemAvailable/{print \$2}" /proc/meminfo) -ge ${DX_REWORK_MIN_MEMORY_KB:-262144} ]]'; check disk bash -c '[[ $(df -Pk "${1}"|awk "NR==2{print \$4}") -ge ${DX_REWORK_MIN_DISK_KB:-1048576} ]]' _ "$DX_ROOT"
check root-boundary assert_safe_path "$DX_ROOT"
nginx_conf="${DX_REWORK_NGINX_CONFIG:-$DX_ROOT/shared/nginx.conf}"; check nginx-regular bash -c '[[ -f "$1" && ! -L "$1" ]]' _ "$nginx_conf"; check nginx-rendered bash -c '! grep -Eq "__[A-Z0-9_]+__|staging-api\.dxerp\.org\.cn" "$1"' _ "$nginx_conf"
: "${DX_REWORK_SERVER_NAME:=}" "${DX_REWORK_TLS_CERT:=}" "${DX_REWORK_TLS_KEY:=}"; check domain bash -c '[[ "$1" =~ ^[A-Za-z0-9.-]+$ && "$1" != staging-api.dxerp.org.cn ]]' _ "$DX_REWORK_SERVER_NAME"
for f in "$DX_REWORK_TLS_CERT" "$DX_REWORK_TLS_KEY"; do check tls-file bash -c '[[ -f "$1" && ! -L "$1" && ! "$1" -ef /dev/null ]]' _ "$f"; done
check tls-expiry openssl x509 -checkend 86400 -noout -in "$DX_REWORK_TLS_CERT"; check tls-host openssl x509 -checkhost "$DX_REWORK_SERVER_NAME" -noout -in "$DX_REWORK_TLS_CERT"; check tls-key-mode bash -c 'm=$(stat -c %a "$1"); (( (8#$m & 0077) == 0 ))' _ "$DX_REWORK_TLS_KEY"
check nginx-sudo-test sudo -n nginx -t; check nginx-sudo-reload-permission sudo -n -l -- nginx -s reload; check nginx-loaded bash -c 'n=$(sudo -n nginx -T 2>&1|grep -Ec "^[[:space:]]*server_name[[:space:]]+$1;"); [[ $n == 2 ]]' _ "$DX_REWORK_SERVER_NAME"
bundle="$(realpath "$bundle")"; check release-api assert_release "$bundle/api" "$sha" "$bundle"; check release-frontend assert_release "$bundle/frontend" "$sha" "$bundle"
if (ss -ltn 2>/dev/null||true)|grep -qE ':3201[[:space:]]'; then
  check port-owner bash -c 'pm2 jlist | node -e '\''let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let a=JSON.parse(s).filter(x=>x.name==="dx-rework-api"&&x.pm2_env?.status==="online");if(a.length!==1||a[0].pm2_env.pm_cwd!=="/opt/dx-rework/current")process.exit(1)})'\'' && test -L /opt/dx-rework/current && curl -fsS http://127.0.0.1:3201/health/live >/dev/null'
else safe_log pass port3201-free; fi
config_env=(NODE_ENV=production GIT_SHA="$sha" BUILD_TIME="$(manifest_field "$bundle/api/release-manifest.json" buildTime)" HOST=127.0.0.1 PORT=3201 SERVICE_NAME=dx-rework-api)
for key in $DX_REWORK_APP_ENV_KEYS; do [[ -v "$key" ]] && config_env+=("$key=${!key}"); done
check production-config env -i PATH="$PATH" "${config_env[@]}" "$DX_REWORK_NODE_BIN" -e 'import(process.argv[1]).then(m=>{m.loadConfig(process.env);console.log("configuration fields valid")})' "$bundle/api/packages/config/dist/index.js"
(( fail == 0 )) || { safe_log blocked 'preflight blocked deployment'; exit 1; }
