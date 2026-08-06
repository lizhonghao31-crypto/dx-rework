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
  base=http://127.0.0.1:3201
else
  [[ ! -e "$(release_switch_flag)" ]] || die 'external smoke cannot run while release maintenance is enabled'
  if [[ -z "${DX_REWORK_SMOKE_URL:-}" ]]; then
    load_deploy_config
    [[ "${DX_REWORK_SERVER_NAME:-}" =~ ^[A-Za-z0-9.-]+$ ]] || die 'invalid smoke server name'
    DX_REWORK_SMOKE_URL="https://${DX_REWORK_SERVER_NAME}"
  fi
  base="$DX_REWORK_SMOKE_URL"
  [[ "$base" == https://* ]] || die 'HTTPS smoke URL required'
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

json="$(curl -fsS "$base/version")"
node_exec -e '
const v=JSON.parse(process.argv[1]);
if(v.gitSha!==process.argv[2]||v.expectedSchemaVersion!==process.argv[3]||v.schemaVersion!==process.argv[3])process.exit(1);
' "$json" "$sha" "$schema"

curl -fsS "$base/health/live" >/dev/null
[[ "${DX_REWORK_REQUIRE_LOCAL_READY:-true}" != true ]] || curl -fsS "$base/health/ready" >/dev/null

if [[ "$local_mode" == true ]]; then
  safe_log pass "local API activation smoke passed $sha"
  exit 0
fi

sudo -n nginx -t
curl -fsS "$base/health/ready" >/dev/null
headers="$(mktemp)"
body="$(mktemp)"
trap 'rm -f "$headers" "$body"' EXIT

curl -fsS -D "$headers" "$base/" -o "$body"
grep -qi '<html' "$body"
grep -Eqi '^x-content-type-options:[[:space:]]*nosniff' "$headers"
grep -Eqi '^referrer-policy:' "$headers"
curl -fsS "$base/login" | grep -qi '<html'
curl -fsS "$base/rework/deep-link-smoke" | grep -qi '<html'

asset="$(sed -nE 's#.*(assets/[^" ]+).*#\1#p' "$body" | head -1)"
[[ -n "$asset" ]] || die 'frontend asset reference missing'
curl -fsS -D "$headers" "$base/$asset" -o "$body"
! grep -qi '<html' "$body" || die 'real asset returned HTML'
grep -Eqi '^content-type:[[:space:]]*(text/css|application/(javascript|octet-stream)|font/|image/)' "$headers"

code="$(curl -sS -o "$body" -w '%{http_code}' "$base/assets/pr17-definitely-missing.js")"
[[ "$code" == 404 ]] && ! grep -qi '<html' "$body" || die 'missing asset must be a non-HTML 404'

curl -fsS --compressed -H 'Accept-Encoding: gzip' -D "$headers" "$base/$asset" -o /dev/null
grep -Eqi '^content-encoding:[[:space:]]*gzip' "$headers" || die 'gzip not active'

conf="${DX_REWORK_NGINX_CONFIG:-$DX_ROOT/shared/nginx.conf}"
grep -q 'dx_rework_query_free' "$conf"
grep -A3 -E 'location = /(rework/)?api/auth/qr/callback' "$conf" | grep -q 'error_log /dev/null emerg'

safe_log blocked 'real OSS/DingTalk/Todo smoke requires isolated authorization'
safe_log pass "read-only HTTPS smoke passed $sha"
