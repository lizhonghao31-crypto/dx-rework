#!/usr/bin/env bash
set -euo pipefail; source "$(dirname "$0")/lib.sh"; [[ $# == 2 ]] || die 'usage: smoke.sh SHA SCHEMA'; sha="$1" schema="$2"; require_sha "$sha"
[[ "$(basename "$(readlink -f "$DX_ROOT/current")")" == "$sha" && "$(basename "$(readlink -f "$DX_ROOT/frontend/current")")" == "$sha" ]] || die 'current API/frontend SHA mismatch'
local_mode="${DX_REWORK_SMOKE_LOCAL:-false}"
if [[ "$local_mode" == true ]]; then base=http://127.0.0.1:3201; else base="${DX_REWORK_SMOKE_URL:?explicit smoke URL required}"; [[ "$base" == https://* ]] || die 'HTTPS smoke URL required'; fi
pm2 jlist | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=JSON.parse(s).filter(x=>x.name==="dx-rework-api");const x=a[0];if(a.length!==1||x.pm2_env?.status!=="online"||x.pm2_env.pm_cwd!=="/opt/dx-rework/current"||!String(x.pm2_env.pm_exec_path||x.pm2_env.script||"").includes("/opt/dx-rework/current/scripts/deploy/start-api.sh"))process.exit(1)})'
json="$(curl -fsS "$base/version")"; node -e 'const v=JSON.parse(process.argv[1]);if(v.gitSha!==process.argv[2]||v.expectedSchemaVersion!==process.argv[3]||v.schemaVersion!==process.argv[3])process.exit(1)' "$json" "$sha" "$schema"
curl -fsS "$base/health/live" >/dev/null; [[ "${DX_REWORK_REQUIRE_LOCAL_READY:-true}" != true ]] || curl -fsS "$base/health/ready" >/dev/null
if [[ "$local_mode" == true ]]; then safe_log pass "local API activation smoke passed $sha"; exit 0; fi
sudo -n nginx -t; curl -fsS "$base/health/ready" >/dev/null
headers="$(mktemp)"; body="$(mktemp)"; trap 'rm -f "$headers" "$body"' EXIT; curl -fsS -D "$headers" "$base/" -o "$body"; grep -qi '<html' "$body"; grep -Eqi '^x-content-type-options:[[:space:]]*nosniff' "$headers"; grep -Eqi '^referrer-policy:' "$headers"
curl -fsS "$base/login"|grep -qi '<html'; curl -fsS "$base/rework/deep-link-smoke"|grep -qi '<html'
asset="$(sed -nE 's#.*(assets/[^" ]+).*#\1#p' "$body"|head -1)"; [[ -n "$asset" ]]; curl -fsS -D "$headers" "$base/$asset" -o "$body"; ! grep -qi '<html' "$body"; grep -Eqi '^content-type:[[:space:]]*(text/css|application/(javascript|octet-stream)|font/|image/)' "$headers"
code="$(curl -sS -o "$body" -w '%{http_code}' "$base/assets/pr17-definitely-missing.js")"; [[ "$code" == 404 ]] && ! grep -qi '<html' "$body" || die 'missing asset must be a non-HTML 404'
curl -fsS --compressed -H 'Accept-Encoding: gzip' -D "$headers" "$base/$asset" -o /dev/null; grep -Eqi '^content-encoding:[[:space:]]*gzip' "$headers" || die 'gzip not active'
conf="${DX_REWORK_NGINX_CONFIG:-$DX_ROOT/shared/nginx.conf}"; grep -q 'dx_rework_query_free' "$conf"; grep -A3 -E 'location = /(rework/)?api/auth/qr/callback' "$conf"|grep -q 'error_log /dev/null emerg'
safe_log blocked 'real OSS/DingTalk/Todo smoke requires isolated authorization'; safe_log pass "read-only HTTPS smoke passed $sha"
