#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/lib.sh"
fail=0; check(){ local name="$1"; shift; if "$@" >/dev/null 2>&1; then safe_log pass "$name"; else safe_log fail "$name"; fail=1; fi; }
[[ $# == 2 ]] || die 'usage: preflight.sh SHA RELEASE_DIR'; sha="$1"; release="$2"; require_sha "$sha"
for c in node npm nginx pm2 pg_dump pg_restore psql realpath sha256sum flock; do check "command:$c" command -v "$c"; done
check os test "$(uname -s)" = Linux; check node22 bash -c '[[ $(node -p "process.versions.node.split(`.`)[0]") == 22 ]]'; check npm10 bash -c '[[ $(npm -v|cut -d. -f1) == 10 ]]'
check memory bash -c '[[ $(awk "/MemAvailable/{print \$2}" /proc/meminfo) -ge ${DX_REWORK_MIN_MEMORY_KB:-262144} ]]'; check disk bash -c '[[ $(df -Pk /opt 2>/dev/null|awk "NR==2{print \$4}") -ge ${DX_REWORK_MIN_DISK_KB:-1048576} ]]'
check port3201 bash -c '! (ss -ltn 2>/dev/null || true) | grep -qE ":3201[[:space:]]"'
check root-boundary assert_safe_path "$DX_ROOT"; env_file="$DX_ROOT/shared/.env"; check env-regular bash -c '[[ -f "$1" && ! -L "$1" ]]' _ "$env_file"; check env-mode require_mode "$env_file" 600
: "${DX_REWORK_SERVER_NAME:=}"; : "${DX_REWORK_TLS_CERT:=}"; : "${DX_REWORK_TLS_KEY:=}"; : "${DX_REWORK_DEPLOY_USER:=}"; : "${DX_REWORK_DATABASE_NAME:=}"; : "${DX_REWORK_OSS_BUCKET:=}"; : "${DINGTALK_CORP_ID:=}"; : "${TODO_RUNTIME_ACTOR_ID:=}"
check domain bash -c '[[ "$1" =~ ^[A-Za-z0-9.-]+$ && "$1" != *placeholder* && "$1" != *.invalid && "$1" != staging-api.dxerp.org.cn && "$1" != *dxerp* ]]' _ "$DX_REWORK_SERVER_NAME"
for v in DX_REWORK_TLS_CERT DX_REWORK_TLS_KEY DX_REWORK_DEPLOY_USER DX_REWORK_DATABASE_NAME DX_REWORK_OSS_BUCKET DINGTALK_CORP_ID TODO_RUNTIME_ACTOR_ID; do check "env:$v" bash -c '[[ -n "${!1}" ]]' _ "$v"; done
check nginx-template bash -c '! grep -REq "__[A-Z0-9_]+__|staging-api\.dxerp\.org\.cn" "$1"' _ "${DX_REWORK_NGINX_CONFIG:-$DX_ROOT/shared/nginx.conf}"
check pm2-config bash -c 'grep -q dx-rework-api "$1" && ! grep -Eq "daxing-(erp|sample)" "$1"' _ "${DX_REWORK_PM2_CONFIG:-infra/pm2/ecosystem.config.cjs}"
check release assert_release "$release" "$sha"; (( fail == 0 )) || { safe_log blocked 'preflight blocked deployment'; exit 1; }
