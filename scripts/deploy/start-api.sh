#!/usr/bin/env bash
set -euo pipefail
release="$(cd "$(dirname "$0")/../.." && pwd -P)"; env_file="${DX_REWORK_TEST_ENV_FILE:-/opt/dx-rework/shared/.env}"
[[ -f "$env_file" && ! -L "$env_file" ]] || { echo 'shared environment must be a regular file' >&2; exit 64; }
[[ "$(stat -c %a "$env_file")" == 600 ]] || { echo 'shared environment must be mode 0600' >&2; exit 64; }
while IFS= read -r line || [[ -n "$line" ]]; do
  [[ -z "$line" || "$line" == \#* ]] && continue
  [[ "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]] || { echo 'invalid environment line' >&2; exit 64; }
  key="${line%%=*}"; value="${line#*=}"; printf -v "$key" %s "$value"; export "$key"
done < "$env_file"
readarray -t identity < <(node -e 'const m=require(process.argv[1]); for(const k of ["gitSha","buildTime"]) {if(!m[k])process.exit(2);console.log(m[k])}' "$release/release-manifest.json")
export NODE_ENV=production HOST=127.0.0.1 PORT="${DX_REWORK_TEST_PORT:-3201}" SERVICE_NAME=dx-rework-api GIT_SHA="${identity[0]}" BUILD_TIME="${identity[1]}"
node_bin=/usr/bin/node; [[ -n "${DX_REWORK_TEST_ENV_FILE:-}" ]] && node_bin="${DX_REWORK_TEST_NODE:-$node_bin}"; [[ "$node_bin" == /* && -x "$node_bin" ]] || { echo 'approved Node executable unavailable' >&2; exit 64; }
cd "$release"; exec "$node_bin" apps/api/dist/server.js
