#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/lib.sh"

[[ $# == 2 ]] || die 'usage: smoke.sh SHA SCHEMA'
sha="$1"
schema="$2"
require_sha "$sha"
assert_active_release "$sha"

local_mode="${DX_REWORK_SMOKE_LOCAL:-false}"
if [[ "$local_mode" == true ]]; then
  api_base=http://127.0.0.1:3201
  web_base=""
  origin=""
  nginx_mode=local
else
  [[ ! -e "$(release_switch_flag)" ]] || die 'external smoke cannot run while release maintenance is enabled'
  if [[ -z "${DX_REWORK_SMOKE_API_URL:-}" || -z "${DX_REWORK_SMOKE_WEB_URL:-}" || -z "${DX_REWORK_SMOKE_ORIGIN:-}" ]]; then
    load_release_config
  fi
  api_base="$DX_REWORK_SMOKE_API_URL"
  web_base="$DX_REWORK_SMOKE_WEB_URL"
  origin="$DX_REWORK_SMOKE_ORIGIN"
  nginx_mode="$DX_REWORK_NGINX_MODE"
  [[ "$origin" == https://* && "$api_base" == https://* && "$web_base" == https://* ]] || die 'HTTPS smoke URLs required'
  if [[ "$nginx_mode" == shared_path ]]; then
    [[ "$web_base" == "$origin/rework" && "$api_base" == "$origin/rework/api" ]] ||
      die 'shared_path smoke must stay inside /rework/'
  fi
fi

pm2 jlist | node_exec -e '
let s="";
process.stdin.on("data",d=>s+=d).on("end",()=>{
  const root=process.argv[1];
  const apps=JSON.parse(s).filter(x=>x.name==="dx-rework-api");
  const app=apps[0];
  if(apps.length!==1||app.pm2_env?.status!=="online"||app.pm2_env.pm_cwd!==`${root}/current`||!String(app.pm2_env.pm_exec_path||app.pm2_env.script||"").includes(`${root}/current/scripts/deploy/start-api.sh`)) process.exit(1);
});
' "$DX_ROOT"

json="$(curl -fsS "$api_base/version")"
node_exec -e '
const v=JSON.parse(process.argv[1]);
if(v.gitSha!==process.argv[2]||v.expectedSchemaVersion!==process.argv[3]||v.schemaVersion!==process.argv[3])process.exit(1);
' "$json" "$sha" "$schema"

curl -fsS "$api_base/health/live" >/dev/null
[[ "${DX_REWORK_REQUIRE_LOCAL_READY:-true}" != true ]] || curl -fsS "$api_base/health/ready" >/dev/null

if [[ "$local_mode" == true ]]; then
  safe_log pass "local API activation smoke passed $sha"
  exit 0
fi

sudo -n nginx -t
curl -fsS "$api_base/health/ready" >/dev/null
headers="$(mktemp)"
body="$(mktemp)"
trap 'rm -f "$headers" "$body"' EXIT

curl -fsS -D "$headers" "$web_base/" -o "$body"
grep -qi '<html' "$body"
grep -Eqi '^x-content-type-options:[[:space:]]*nosniff' "$headers"
grep -Eqi '^referrer-policy:' "$headers"

if [[ "$nginx_mode" == shared_path ]]; then
  curl -fsS "$web_base/auth/login" | grep -qi '<html'
  curl -fsS "$web_base/deep-link-smoke" | grep -qi '<html'
else
  # Preserve the dedicated-vhost compatibility checks used by the original PR-17 contract.
  curl -fsS "$origin/login" | grep -qi '<html'
  curl -fsS "$origin/rework/deep-link-smoke" | grep -qi '<html'
fi

asset_path="$(sed -nE 's#.*(\/rework/assets/[^" ]+).*#\1#p' "$body" | head -1)"
[[ -n "$asset_path" ]] || die 'frontend asset reference missing'
curl -fsS -D "$headers" "$origin$asset_path" -o "$body"
! grep -qi '<html' "$body" || die 'real asset returned HTML'
grep -Eqi '^content-type:[[:space:]]*(text/css|application/(javascript|octet-stream)|font/|image/)' "$headers"

code="$(curl -sS -o "$body" -w '%{http_code}' "$origin/rework/assets/pr17-definitely-missing.js")"
[[ "$code" == 404 ]] && ! grep -qi '<html' "$body" || die 'missing asset must be a non-HTML 404'

curl -fsS --compressed -H 'Accept-Encoding: gzip' -D "$headers" "$origin$asset_path" -o /dev/null
grep -Eqi '^content-encoding:[[:space:]]*gzip' "$headers" || die 'gzip not active'

conf="${DX_REWORK_NGINX_CONFIG:-$DX_ROOT/shared/nginx.conf}"
grep -q 'dx_rework_query_free' "$conf"
if [[ "$nginx_mode" == shared_path ]]; then
  grep -A6 -F 'location = /rework/auth/qr/relay {' "$conf" | grep -q 'access_log off;'
  grep -A6 -F 'location = /rework/auth/qr/relay {' "$conf" | grep -q 'error_log /dev/null emerg;'
  grep -A7 -F 'location = /rework/api/auth/qr/callback {' "$conf" | grep -q 'access_log off;'
  grep -A7 -F 'location = /rework/api/auth/qr/callback {' "$conf" | grep -q 'error_log /dev/null emerg;'
else
  grep -A3 -E 'location = /(rework/)?api/auth/qr/callback' "$conf" | grep -q 'error_log /dev/null emerg'
fi

safe_log blocked 'real OSS/DingTalk/Todo smoke requires isolated authorization'
safe_log pass "read-only HTTPS smoke passed $sha"
