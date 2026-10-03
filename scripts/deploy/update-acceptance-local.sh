#!/usr/bin/env bash
set -Eeuo pipefail
umask 022
[[ "$(id -un)" == dxacceptance && $# == 3 ]]
sha="$1"; source_dir="$(realpath "$2")"; action="$3"
[[ "$action" == prepare || "$action" == activate ]]
[[ "$sha" =~ ^[0-9a-f]{40}$ && "$source_dir" == /tmp/dx-acceptance-source.* ]]
export DX_REWORK_ROOT=/opt/dx-rework-acceptance
source "$source_dir/scripts/deploy/lib.sh"
for dir in shared logs releases frontend frontend/releases generations locks candidates build; do
  [[ -d "$DX_ROOT/$dir" && ! -L "$DX_ROOT/$dir" && "$(stat -c %U "$DX_ROOT/$dir")" == dxacceptance ]] || die "Acceptance directory unavailable: $dir"
done
load_database_tool_config
export PATH="$(dirname "$(approved_node_bin)"):/usr/local/bin:/usr/bin:/bin"
[[ "$(node_exec -p 'process.versions.node.split(".")[0]')" == 22 ]] || die 'Node 22 is required'
[[ "$(npm --version | cut -d. -f1)" == 10 ]] || die 'npm 10 is required'
acquire_lock "$DX_ROOT/locks/release.lock"
current_generation_sha >/dev/null
build="$DX_ROOT/build/update-$sha"
candidate="$DX_ROOT/candidates/$sha"
assert_safe_path "$build" >/dev/null
assert_safe_path "$candidate" >/dev/null
manifest="$source_dir/apps/api/src/platform/migration-manifest.json"
policy="$source_dir/scripts/deploy/acceptance-update-policy.mjs"
if [[ "$action" == activate ]]; then
  assert_release "$candidate/api" "$sha" "$DX_ROOT/candidates"
  assert_release "$candidate/frontend" "$sha" "$DX_ROOT/candidates"
  cd "$candidate/api"
load_app_config
[[ "${APP_BASE_PATH:-}" == /acceptance/ && "${ROOT_DINGTALK_USER_ID:-}" == uat-root && "${ACCEPTANCE_LAB_ENABLED:-}" == true && "${DIGITAL_PRODUCTION_ENABLED:-}" == true && "${DIGITAL_PRODUCTION_CREATION_ENABLED:-}" == true ]] || die 'Acceptance identity/configuration mismatch'
for key in TODO_RUNTIME_ENABLED TODO_DELIVERY_ENABLED TODO_TIMING_ENABLED; do [[ "${!key:-false}" != true ]] || die "External side effect enabled: $key"; done
for key in OSS_REGION OSS_ENDPOINT OSS_BUCKET OSS_ACCESS_KEY_ID OSS_ACCESS_KEY_SECRET OPENAI_API_KEY; do [[ -z "${!key:-}" ]] || die "External credential forbidden in Acceptance: $key"; done
[[ "$(pg_exec psql "$DATABASE_URL" -XAtqc 'select current_database()')" == dx_rework_acceptance ]] || die 'Acceptance database name mismatch'
  checkpoint_dir="$DX_ROOT/shared/update-checkpoints"
  checkpoint="$checkpoint_dir/$sha.json"
  evidence="$(cat "$checkpoint_dir/$sha.evidence")"
  [[ "$evidence" == "$DX_ROOT/logs/update-$sha-"* && -d "$evidence" && ! -L "$evidence" ]]
  node_exec scripts/deploy/database-state.mjs verify-current "$manifest"
  node_exec scripts/deploy/verify-database-readiness.mjs "$manifest"
echo '[4/5] Activate Acceptance generation'
generation="$(ensure_generation "$sha")"
ensure_active_aliases
atomic_link "$generation" "$DX_ROOT/active"
# A started runtime may create new test data: never reuse an earlier backup on that basis.
rm -f -- "$checkpoint"
phase=runtime
pm2 startOrReload "$DX_ROOT/releases/$sha/infra/pm2/ecosystem.acceptance.config.cjs" --only dx-rework-acceptance-api --update-env
ready=false
for _ in {1..30}; do
  if curl --max-time 3 -fsS http://127.0.0.1:3202/health/ready >/dev/null 2>&1; then ready=true; break; fi
  sleep 1
done
[[ "$ready" == true ]] || die 'Acceptance readiness failed; inspect the current candidate logs'
echo '[5/5] Verify local/public versions, HTML/assets and production health'
node_exec "$source_dir/scripts/deploy/verify-acceptance-update.mjs" "$candidate" | tee "$evidence/verification.json"
trap - ERR
echo "Evidence: $evidence"
  rm -f -- "$checkpoint_dir/$sha.evidence"
  exit 0
fi
echo '[1/5] Validate production migration history (read only)'
node_exec "$policy" "$source_dir/production-history.json" "$manifest" production

echo '[2/5] Prepare immutable candidate'
if [[ ! -d "$candidate" ]]; then
  mkdir -p "$build"
  cp -a "$source_dir/." "$build/"
  cd "$build"
  lock_hash="$(sha256sum package-lock.json | cut -d' ' -f1)"
  dependencies_ready=false
  if [[ -f .dependencies-ready && "$(cat .dependencies-ready)" == "$lock_hash" && -d node_modules && ! -L node_modules ]] && \
    node_exec scripts/deploy/prepare-acceptance-dependencies.mjs && npm ls --depth=0 >/dev/null 2>&1; then
    dependencies_ready=true
  fi
  if [[ "$dependencies_ready" != true ]]; then
    rm -rf -- "$build/node_modules"
    if cmp -s package-lock.json /opt/dx-rework/source/package-lock.json && \
      [[ -d /opt/dx-rework/source/node_modules && ! -L /opt/dx-rework/source/node_modules ]]; then
      if cp -a /opt/dx-rework/source/node_modules "$build/node_modules" && \
        node_exec scripts/deploy/prepare-acceptance-dependencies.mjs && npm ls --depth=0 >/dev/null 2>&1; then
        dependencies_ready=true
      fi
    fi
    if [[ "$dependencies_ready" != true ]]; then
      rm -rf -- "$build/node_modules"
      npm ci --no-audit --no-fund
    fi
    node_exec scripts/deploy/prepare-acceptance-dependencies.mjs
    npm ls --depth=0 >/dev/null
    printf '%s\n' "$lock_hash" > .dependencies-ready
  fi
  node_exec scripts/deploy/prepare-acceptance-dependencies.mjs
  export APP_BASE_PATH=/acceptance/ VITE_BASE_PATH=/acceptance/
  npm run build:packages
  npm run build --workspace @dx-rework/api
  if [[ "$(node_exec "$policy" frontend "$source_dir/changed-paths.txt")" == true ]]; then
    npm run build --workspace @dx-rework/web
  else
    mkdir -p apps/web/dist
    cp -a "$DX_ROOT/frontend/current/." apps/web/dist/
    echo 'Reuse current frontend: no frontend/shared/dependency changes'
  fi
  DX_REWORK_BUILD_ROOT="$DX_ROOT/candidates" bash scripts/deploy/package-release.sh "$sha" "$(date -u +%FT%TZ)" "$candidate"
fi
assert_release "$candidate/api" "$sha" "$DX_ROOT/candidates"
assert_release "$candidate/frontend" "$sha" "$DX_ROOT/candidates"
cmp -s "$manifest" "$candidate/api/apps/api/src/platform/migration-manifest.json" || die 'Candidate migration manifest differs from Git'
[[ "$(manifest_field "$candidate/api/release-manifest.json" appBasePath)" == /acceptance/ ]] || die 'Candidate base path mismatch'
bash "$candidate/api/scripts/deploy/verify-runtime.sh" "$candidate/api"
cd "$candidate/api"
node_exec scripts/check-migration-export.mjs "$source_dir/production-history.json"

echo '[3/5] Validate Acceptance and prepare backup'
load_app_config
[[ "${APP_BASE_PATH:-}" == /acceptance/ && "${ROOT_DINGTALK_USER_ID:-}" == uat-root && "${ACCEPTANCE_LAB_ENABLED:-}" == true && "${DIGITAL_PRODUCTION_ENABLED:-}" == true && "${DIGITAL_PRODUCTION_CREATION_ENABLED:-}" == true ]] || die 'Acceptance identity/configuration mismatch'
for key in TODO_RUNTIME_ENABLED TODO_DELIVERY_ENABLED TODO_TIMING_ENABLED; do [[ "${!key:-false}" != true ]] || die "External side effect enabled: $key"; done
for key in OSS_REGION OSS_ENDPOINT OSS_BUCKET OSS_ACCESS_KEY_ID OSS_ACCESS_KEY_SECRET OPENAI_API_KEY; do [[ -z "${!key:-}" ]] || die "External credential forbidden in Acceptance: $key"; done
[[ "$(pg_exec psql "$DATABASE_URL" -XAtqc 'select current_database()')" == dx_rework_acceptance ]] || die 'Acceptance database name mismatch'
evidence="$DX_ROOT/logs/update-$sha-$(date -u +%Y%m%dT%H%M%SZ)-$$"
mkdir -m 0700 "$evidence"
cp "$source_dir/production-history.json" "$evidence/production-history.json"
export_history() {
  (umask 077; PGOPTIONS='-c default_transaction_read_only=on' pg_exec psql "$DATABASE_URL" -XqAt -v ON_ERROR_STOP=1 -c "BEGIN READ ONLY;
  SELECT json_build_object('database',current_database(),'migrations',coalesce(json_agg(json_build_object('version',version,'checksum',btrim(checksum)) ORDER BY version),'[]'::json)) FROM schema_migrations;
  COMMIT;" > "$evidence/acceptance-history.json")
  node_exec "$policy" "$evidence/acceptance-history.json" "$manifest" acceptance
}
export_history
node_exec scripts/deploy/database-state.mjs verify-prefix "$manifest"
target_version="$(manifest_field "$candidate/api/release-manifest.json" schemaVersion)"
if [[ "$(readlink -f "$DX_ROOT/current")" == "$DX_ROOT/releases/$sha" ]] && \
  node_exec scripts/deploy/database-state.mjs verify-current "$manifest" >/dev/null; then
  node_exec "$source_dir/scripts/deploy/verify-acceptance-update.mjs" "$candidate"
  echo "Already current: $sha"
  exit 10
fi
bash scripts/deploy/install-release.sh "$sha" "$candidate"
status="$(pm2 jlist | node_exec -e 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>{const p=JSON.parse(s).find(x=>x.name==="dx-rework-acceptance-api");if(!p)process.exit(1);process.stdout.write(p.pm2_env.status)})')"
was_stopped=false
[[ "$status" != stopped ]] || was_stopped=true
phase=stopping
trap 'rc=$?; if [[ "$phase" == migrating ]]; then pm2 stop dx-rework-acceptance-api >/dev/null 2>&1 || true; fi; echo "STOP phase=$phase evidence=$evidence exit=$rc; retain candidate and backup for forward retry" >&2' ERR
pm2 stop dx-rework-acceptance-api >/dev/null
phase=migrating
export_history
current_before="$(node_exec scripts/deploy/database-state.mjs print-current)"
pending="$(node_exec -e 'const [s,m]=process.argv.slice(1).map(JSON.parse);process.stdout.write(String(s.count!==m.migrations.length||s.version!==m.migrations.at(-1).version||s.checksum!==m.migrations.at(-1).checksum))' "$current_before" "$(cat "$manifest")")"
checkpoint_dir="$DX_ROOT/shared/update-checkpoints"
install -d -m 0700 "$checkpoint_dir"
checkpoint="$checkpoint_dir/$sha.json"
if [[ "$pending" == true ]]; then
  history_hash="$(sha256sum "$evidence/acceptance-history.json" | cut -d' ' -f1)"
  fingerprint="$(node_exec scripts/deploy/database-state.mjs fingerprint)"
  reuse=false
  if [[ -f "$checkpoint" ]]; then
    reuse="$(node_exec --input-type=module - "$policy" "$checkpoint" "$sha" "$history_hash" "$fingerprint" "$was_stopped" <<'JS'
import fs from 'node:fs';import {pathToFileURL} from 'node:url';
const [policy,file,sha,history,fingerprint,stopped]=process.argv.slice(2);
const {mayReuseBackup}=await import(pathToFileURL(policy));
process.stdout.write(String(mayReuseBackup(JSON.parse(fs.readFileSync(file,'utf8')),{sha,history,fingerprint,wasStopped:stopped==='true'})));
JS
    )"
  fi
  if [[ "$reuse" == true ]]; then
    backup="$(node_exec -e 'process.stdout.write(require(process.argv[1]).backup)' "$checkpoint")"
    assert_safe_path "$backup" "$DX_ROOT/backups/postgres" >/dev/null
    [[ -f "$backup/COMPLETE" ]]
    verify_sums "$backup"
    echo "Reuse verified pre-migration backup: $backup"
  else
    GIT_SHA="$sha" CURRENT_DATABASE_STATE="$current_before" TARGET_SCHEMA_VERSION="$target_version" \
      TARGET_SCHEMA_CHECKSUM="$(manifest_field "$candidate/api/release-manifest.json" schemaChecksum)" \
      bash scripts/backup-postgres.sh > "$evidence/backup.log"
    cat "$evidence/backup.log"
    backup="$(node_exec -e 'const fs=require("fs");const lines=fs.readFileSync(process.argv[1],"utf8").trim().split("\n");const row=lines.map(x=>JSON.parse(x)).find(x=>x.status==="pass"&&x.message.startsWith("backup_set="));if(!row)process.exit(1);process.stdout.write(row.message.split(" ")[0].slice(11))' "$evidence/backup.log")"
    node_exec - "$checkpoint" "$sha" "$history_hash" "$fingerprint" "$backup" <<'JS'
const fs=require('fs');const [file,sha,history,fingerprint,backup]=process.argv.slice(2);
fs.writeFileSync(file,JSON.stringify({phase:'stopped',sha,history,fingerprint,backup}),{mode:0o600});
JS
  fi
fi
# Hand only the actual local database identity to the root maintenance controller.
pg_exec psql "$DATABASE_URL" -XqAt -v ON_ERROR_STOP=1 -c "SELECT json_build_object('database',current_database(),'port',current_setting('port')::integer,'oid',(SELECT oid FROM pg_database WHERE datname=current_database()),'address',inet_server_addr())" > "$source_dir/acceptance-identity.json"
(umask 077; printf '%s\n' "$evidence" > "$checkpoint_dir/$sha.evidence")
trap - ERR
echo 'Acceptance stopped and backed up; ready for owner-role maintenance'
