#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname "$0")/lib.sh"
[[ "$(id -un)" == dxrework && $# == 3 ]] || die 'slot operation requires dxrework'
action="$1"; sha="$2"; port="$3"
require_sha "$sha"
[[ "$port" == 3201 || "$port" == 3203 ]] || die 'invalid slot'
name="dx-rework-api-$port"
case "$action" in
  start)
    api="$DX_ROOT/releases/$sha"
    assert_release "$api" "$sha"
    # An existing slot must never be restarted underneath accepted requests.
    if pm2 describe "$name" >/dev/null 2>&1; then
      live_sha="$(curl --noproxy '*' --connect-timeout 2 --max-time 3 -fsS "http://127.0.0.1:$port/version" | node -e 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>process.stdout.write(JSON.parse(s).gitSha))')"
      [[ "$live_sha" == "$sha" ]] || die 'slot already belongs to another release'
      exit 0
    fi
    DX_REWORK_RELEASE_PORT="$port" pm2 start "$api/scripts/deploy/start-api.sh" --name "$name" --interpreter /usr/bin/bash --cwd "$api" --kill-timeout 300000 --time
    ;;
  stop)
    # Caller has already drained every nginx worker for this generation.
    if pm2 describe "$name" >/dev/null 2>&1; then pm2 delete "$name"; fi
    ;;
  *) die 'unknown slot operation' ;;
esac
