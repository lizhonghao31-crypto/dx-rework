#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/lib.sh"; [[ $# == 1 ]] || die 'usage: verify-runtime.sh API_RELEASE'
api="$(realpath "$1")"; manifest="$api/release-manifest.json"; port="${DX_REWORK_TEST_PORT:-$((20000 + RANDOM % 20000))}"; probe="$api/.runtime-probe.mjs"; log="$(mktemp)"
[[ -f "$api/apps/api/src/platform/migration-manifest.json" ]] || die 'artifact migration manifest missing at runtime path'
trap '[[ -n "${pid:-}" ]] && kill "$pid" 2>/dev/null || true; rm -f "$probe" "$log"' EXIT
cat >"$probe" <<'JS'
import {buildApp} from './apps/api/dist/app.js';import {loadConfig} from './packages/config/dist/index.js';import manifest from './release-manifest.json' with {type:'json'};
const config=loadConfig({...process.env,NODE_ENV:'production',HOST:'127.0.0.1',PORT:process.env.DX_REWORK_TEST_PORT,DATABASE_URL:'postgresql://unreachable:unreachable@127.0.0.1:1/unreachable',SESSION_SECRET:'0123456789abcdef0123456789abcdef',APP_BASE_PATH:'/',DINGTALK_CORP_ID:'test-corp',DINGTALK_H5_APP_KEY:'test-key',DINGTALK_H5_APP_SECRET:'test-secret',DINGTALK_WEB_CLIENT_ID:'test-client',DINGTALK_WEB_CLIENT_SECRET:'test-web-secret',DINGTALK_QR_REDIRECT_URI:'https://example.test/auth/callback',TODO_RUNTIME_ENABLED:'false',GIT_SHA:manifest.gitSha,BUILD_TIME:manifest.buildTime});
const app=buildApp({config,checkDatabase:async()=>{throw Error('intentionally unreachable')},getAppliedSchemaHistory:async()=>null});await app.listen({host:'127.0.0.1',port:Number(process.env.DX_REWORK_TEST_PORT)});
JS
DX_REWORK_TEST_PORT="$port" "$(command -v node)" "$probe" >"$log" 2>&1 & pid=$!
for _ in {1..100}; do kill -0 "$pid" 2>/dev/null || { cat "$log" >&2; die 'artifact API exited before live'; }; curl -fsS "http://127.0.0.1:$port/health/live" >/dev/null 2>&1 && break; sleep .1; done
live="$(curl -fsS "http://127.0.0.1:$port/health/live")"; version="$(curl -fsS "http://127.0.0.1:$port/version")"
node -e 'const [v,m]=process.argv.slice(1).map(JSON.parse);if(v.gitSha!==m.gitSha||v.expectedSchemaVersion!==m.schemaVersion)process.exit(1)' "$version" "$(cat "$manifest")"
safe_log pass 'artifact API dependency resolution and live/version verified'
