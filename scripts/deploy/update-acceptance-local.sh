#!/usr/bin/env bash
set -Eeuo pipefail
umask 022
[[ "$(id -un)" == dxacceptance && $# == 4 ]]
sha="$1"; source_dir="$(realpath "$2")"; action="$3"; tool_root="$(realpath "$4")"
[[ "$action" == prepare || "$action" == backup || "$action" == stop || "$action" == recover || "$action" == halt || "$action" == activate ]]
[[ "$sha" =~ ^[0-9a-f]{40}$ && "$source_dir" == /tmp/dx-acceptance-source.* ]]
export DX_REWORK_ROOT=/opt/dx-rework-acceptance
source "$tool_root/scripts/deploy/lib.sh"
for dir in shared logs releases frontend frontend/releases generations locks candidates build; do
  [[ -d "$DX_ROOT/$dir" && ! -L "$DX_ROOT/$dir" && "$(stat -c %U "$DX_ROOT/$dir")" == dxacceptance ]] || die "Acceptance directory unavailable: $dir"
done
load_database_tool_config
export PATH="$(dirname "$(approved_node_bin)"):/usr/local/bin:/usr/bin:/bin"
export PM2_HOME=/home/dxacceptance/.pm2
[[ "$(node_exec -p 'process.versions.node.split(".")[0]')" == 22 ]] || die 'Node 22 is required'
[[ "$(npm --version | cut -d. -f1)" == 10 ]] || die 'npm 10 is required'
acquire_lock "$DX_ROOT/locks/release.lock"
current_generation_sha >/dev/null
build="$DX_ROOT/build/update-$sha"
candidate="$DX_ROOT/candidates/$sha"
assert_safe_path "$build" >/dev/null
assert_safe_path "$candidate" >/dev/null
manifest="$source_dir/apps/api/src/platform/migration-manifest.json"
policy="$tool_root/scripts/deploy/acceptance-update-policy.mjs"
check_live_identity() {
  pg_exec psql "$DATABASE_URL" -XqAt -v ON_ERROR_STOP=1 -c "SELECT json_build_object('database',current_database(),'port',current_setting('port')::integer,'oid',(SELECT oid::bigint FROM pg_database WHERE datname=current_database()),'address',inet_server_addr(),'role',current_user,'sessionRole',session_user)" > "$evidence/live-acceptance-identity.json"
  cmp -s "$source_dir/acceptance-identity.json" "$evidence/live-acceptance-identity.json" || die 'Acceptance identity changed since the capacity preflight'
}
if [[ "$action" != prepare ]]; then
  evidence="$(cat "$source_dir/worker-evidence")"
  [[ "$evidence" == "$DX_ROOT/logs/update-$sha-"* && -d "$evidence" && ! -L "$evidence" ]]
  # Failure routing must stop the candidate even when storage cannot allocate
  # more evidence. Keep identity/path guards, but perform no optional copy first.
  if [[ "$action" == halt ]]; then
    if ! node_exec "$tool_root/scripts/deploy/acceptance-pm2-activation.mjs" halt "$sha" "$(cat "$evidence/previous-sha")" "$evidence"; then
      echo failed-runtime-state-unverified > "$evidence/phase"
      exit 1
    fi
    echo failed-runtime-stopped > "$evidence/phase"
    exit 0
  fi
  mkdir -p "$evidence/preflight"
  cp -rn "$source_dir/.acceptance-preflight/." "$evidence/preflight/"
  load_app_config
  export PGCONNECT_TIMEOUT=10
  check_live_identity
  if [[ "$action" == backup ]]; then
    current_before="$(node_exec "$candidate/api/scripts/deploy/database-state.mjs" print-current)"
    node_exec "$candidate/api/scripts/deploy/database-state.mjs" verify-prefix "$manifest"
    # A matching migration hash cannot prove no business writes since an old dump.
    # Each non-current update attempt gets one new consistent backup before stop.
    GIT_SHA="$sha" CURRENT_DATABASE_STATE="$current_before" \
      TARGET_SCHEMA_VERSION="$(manifest_field "$candidate/api/release-manifest.json" schemaVersion)" \
      TARGET_SCHEMA_CHECKSUM="$(manifest_field "$candidate/api/release-manifest.json" schemaChecksum)" \
      bash "$candidate/api/scripts/backup-postgres.sh" > "$evidence/backup.log"
    cat "$evidence/backup.log"
    # Catalog ownership/ACL are deliberately absent from the existing database dump.
    PGOPTIONS='-c default_transaction_read_only=on' pg_exec psql "$DATABASE_URL" -XqAt -v ON_ERROR_STOP=1 \
      -c "SELECT json_build_object('schema',n.nspname,'name',c.relname,'kind',c.relkind,'owner',pg_get_userbyid(c.relowner),'acl',c.relacl) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' ORDER BY c.relname" > "$evidence/object-ownership.jsonl"
    # Reserve one database-size worth of headroom (at least 256 MiB) before stop.
    database_bytes="$(pg_exec psql "$DATABASE_URL" -XAtqc 'select pg_database_size(current_database())')"
    available_kib="$(df -Pk "$DX_ROOT" | awk 'NR==2 {print $4}')"
    [[ "$database_bytes" =~ ^[0-9]+$ && "$available_kib" =~ ^[0-9]+$ ]]
    (( available_kib * 1024 >= database_bytes && available_kib * 1024 >= 268435456 )) || die 'Insufficient migration disk headroom; API has not been stopped'
    echo backup-complete > "$evidence/phase"
    exit 0
  fi
  if [[ "$action" == stop ]]; then
    [[ "$(cat "$evidence/phase")" == backup-complete ]]
    node_exec "$tool_root/scripts/deploy/acceptance-pm2-activation.mjs" stop "$sha" "$(cat "$evidence/previous-sha")" "$evidence"
    echo stopped > "$evidence/phase"
    node_exec "$candidate/api/scripts/deploy/database-state.mjs" export-history > "$evidence/stopped-history.json"
    cmp -s "$evidence/initial-history.json" "$evidence/stopped-history.json" || die 'History changed between preflight and stop; remain stopped'
    exit 0
  fi
  if [[ "$action" == recover ]]; then
    [[ "$(cat "$evidence/initial-status")" == online ]] || die 'Previously stopped; no automatic old-service startup'
    node_exec "$candidate/api/scripts/deploy/database-state.mjs" export-history > "$evidence/failed-history.json"
    node_exec "$policy" recover "$(cat "$evidence/initial-status")" "$evidence/stopped-history.json" "$evidence/failed-history.json"
    previous="$(cat "$evidence/previous-sha")"
    assert_active_release "$previous"
    node_exec "$DX_ROOT/current/scripts/deploy/database-state.mjs" verify-current "$DX_ROOT/current/apps/api/src/platform/migration-manifest.json"
    DX_REWORK_ACCEPTANCE_RELEASE_SHA="$previous" pm2 startOrReload "$tool_root/infra/pm2/ecosystem.acceptance.config.cjs" --only dx-rework-acceptance-api --update-env
    for _ in {1..30}; do
      if curl --max-time 3 -fsS http://127.0.0.1:3202/health/ready >/dev/null 2>&1; then break; fi
      sleep 1
    done
    node_exec "$tool_root/scripts/deploy/verify-acceptance-update.mjs" "$DX_ROOT/generations/$previous" "$source_dir/production-runtime.json"
    pm2 save
    node_exec "$tool_root/scripts/deploy/acceptance-runtime-state.mjs" "$previous" saved > "$evidence/recovered-runtime.json"
    echo old-runtime-verified > "$evidence/phase"
    exit 0
  fi
fi
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
  [[ "$evidence" == "$DX_ROOT/logs/update-$sha-"* && -d "$evidence" && ! -L "$evidence" ]]
  node_exec scripts/deploy/database-state.mjs verify-current "$manifest"
  node_exec scripts/deploy/verify-database-readiness.mjs "$manifest"
  node_exec scripts/deploy/database-state.mjs export-history > "$evidence/activation-history.json"
echo '[4/5] Activate Acceptance generation'
generation="$(ensure_generation "$sha")"
ensure_active_aliases
atomic_link "$generation" "$DX_ROOT/active"
# A started runtime may create new test data: never reuse an earlier backup on that basis.
rm -f -- "$checkpoint"
phase=runtime
echo runtime > "$evidence/phase"
node_exec "$tool_root/scripts/deploy/acceptance-pm2-activation.mjs" activate "$sha" "$(cat "$evidence/previous-sha")" "$evidence"
ready=false
for _ in {1..30}; do
  if curl --max-time 3 -fsS http://127.0.0.1:3202/health/ready >/dev/null 2>&1; then ready=true; break; fi
  sleep 1
done
[[ "$ready" == true ]] || die 'Acceptance readiness failed; inspect the current candidate logs'
echo '[5/5] Verify local/public versions, HTML/assets and production health'
node_exec "$tool_root/scripts/deploy/verify-acceptance-update.mjs" "$candidate" "$source_dir/production-runtime.json" | tee "$evidence/verification.json"
echo runtime-verified-awaiting-persistence > "$evidence/phase"
pm2 save
node_exec "$tool_root/scripts/deploy/acceptance-runtime-state.mjs" "$sha" saved > "$evidence/saved-runtime.json"
node_exec "$tool_root/scripts/deploy/acceptance-pm2-activation.mjs" complete "$sha" "$(cat "$evidence/previous-sha")" "$evidence"
trap - ERR
echo "Evidence: $evidence"
  echo verified > "$evidence/phase"
  exit 0
fi
echo '[1/5] Validate production migration history (read only)'
node_exec "$policy" "$source_dir/production-history.json" "$manifest" production

echo '[2/5] Prepare immutable candidate'
if [[ ! -d "$candidate" ]]; then
  mkdir -p "$build"
  cp -a "$source_dir/." "$build/"
  cd "$build"
  [[ ! -L "$DX_ROOT/build/npm-cache" && ! -L "$DX_ROOT/build/tmp" ]] || die 'Acceptance cache/temp path cannot be shared symlinks'
  mkdir -m 0700 -p "$DX_ROOT/build/npm-cache" "$DX_ROOT/build/tmp"
  export npm_config_cache="$DX_ROOT/build/npm-cache" TMPDIR="$DX_ROOT/build/tmp"
  lock_hash="$(sha256sum package-lock.json | cut -d' ' -f1)"
  dependencies_ready=false
  if [[ -f .dependencies-ready && "$(cat .dependencies-ready)" == "$lock_hash" && -d node_modules && ! -L node_modules ]] && \
    node_exec "$tool_root/scripts/deploy/prepare-acceptance-dependencies.mjs" && npm ls --depth=0 >/dev/null 2>&1; then
    dependencies_ready=true
  fi
  if [[ "$dependencies_ready" != true ]]; then
    rm -rf -- "$build/node_modules"
    if cmp -s package-lock.json /opt/dx-rework/source/package-lock.json && \
      [[ -d /opt/dx-rework/source/node_modules && ! -L /opt/dx-rework/source/node_modules ]]; then
      if cp -a /opt/dx-rework/source/node_modules "$build/node_modules" && \
        node_exec "$tool_root/scripts/deploy/prepare-acceptance-dependencies.mjs" && npm ls --depth=0 >/dev/null 2>&1; then
        dependencies_ready=true
      fi
    fi
    if [[ "$dependencies_ready" != true ]]; then
      rm -rf -- "$build/node_modules"
      npm ci --no-audit --no-fund
    fi
    node_exec "$tool_root/scripts/deploy/prepare-acceptance-dependencies.mjs"
    npm ls --depth=0 >/dev/null
    printf '%s\n' "$lock_hash" > .dependencies-ready
  fi
  node_exec "$tool_root/scripts/deploy/prepare-acceptance-dependencies.mjs"
  export APP_BASE_PATH=/acceptance/ VITE_BASE_PATH=/acceptance/
  npm run build:packages
  npm run build --workspace @dx-rework/api
  npm run build --workspace @dx-rework/web
  DX_REWORK_BUILD_ROOT="$DX_ROOT/candidates" bash scripts/deploy/package-release.sh "$sha" "$(date -u +%FT%TZ)" "$candidate"
  node_exec - "$candidate/build-provenance.json" "$sha" "$(cat "$tool_root/TOOL_SHA")" <<'JS'
const fs=require('fs');const [file,sha,toolSha]=process.argv.slice(2);
fs.writeFileSync(file,JSON.stringify({sourceSha:sha,frontendSourceSha:sha,toolSha,frontendBuilt:true})+'\n');
JS
  (cd "$candidate" && sha256sum build-provenance.json >> SHA256SUMS)

fi
verify_sums "$candidate"
node_exec -e 'const p=require(process.argv[1]);if(p.sourceSha!==process.argv[2]||p.frontendSourceSha!==process.argv[2]||p.frontendBuilt!==true)process.exit(1)' "$candidate/build-provenance.json" "$sha"
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
mkdir -p "$evidence/preflight"
cp -rn "$source_dir/.acceptance-preflight/." "$evidence/preflight/"
cp "$source_dir/production-history.json" "$evidence/production-history.json"
export_history() {
  (umask 077; PGOPTIONS='-c default_transaction_read_only=on' pg_exec psql "$DATABASE_URL" -XqAt -v ON_ERROR_STOP=1 -c "BEGIN READ ONLY" -c "SELECT json_build_object('database',current_database(),'migrations',coalesce(json_agg(json_build_object('version',version,'checksum',btrim(checksum)) ORDER BY version),'[]'::json)) FROM schema_migrations" -c COMMIT > "$evidence/acceptance-history.json")
  node_exec "$policy" "$evidence/acceptance-history.json" "$manifest" acceptance
}
export_history
node_exec scripts/deploy/database-state.mjs verify-prefix "$manifest"
target_version="$(manifest_field "$candidate/api/release-manifest.json" schemaVersion)"
previous="$(manifest_field "$DX_ROOT/current/release-manifest.json" gitSha)"
schema_current=false
if node_exec scripts/deploy/database-state.mjs verify-current "$manifest" >/dev/null; then schema_current=true; fi
node_exec "$candidate/api/scripts/deploy/database-state.mjs" export-history > "$evidence/initial-history.json"
check_live_identity
node_exec - "$PM2_HOME/pm2.pid" <<'JS'
const fs=require('fs'),file=process.argv[2],stat=fs.lstatSync(file),pid=Number(fs.readFileSync(file,'utf8').trim());
if(stat.isSymbolicLink()||!stat.isFile()||!Number.isSafeInteger(pid)||pid<=1)throw Error('Existing Acceptance PM2 daemon is required');
process.kill(pid,0);
JS
status="$(pm2 jlist | node_exec -e 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>{const rows=JSON.parse(s),p=rows.find(x=>x.name==="dx-rework-acceptance-api");if(!p){if(rows.length===0){process.stdout.write("missing");return;}process.exit(1);}process.stdout.write(p.pm2_env.status)})')"
if [[ "$status" == missing ]]; then
  [[ "$previous" == "$sha" && "$schema_current" == true ]] || die 'Missing Acceptance registration without a current candidate schema'
  assert_active_release "$sha"
  node_exec "$tool_root/scripts/deploy/acceptance-pm2-activation.mjs" recover "$sha" "$previous" "$evidence"
  status=stopped
fi
[[ "$status" == online || "$status" == stopped ]] || die 'Acceptance is neither online nor explicitly stopped'
printf '%s\n' "$status" > "$evidence/initial-status"
printf '%s\n' "$previous" > "$evidence/previous-sha"
if [[ "$status" == online ]]; then
  node_exec "$DX_ROOT/current/scripts/deploy/database-state.mjs" verify-current "$DX_ROOT/current/apps/api/src/platform/migration-manifest.json"
  curl --max-time 15 -fsS http://127.0.0.1:3202/health/ready >/dev/null
  version="$(curl --max-time 15 -fsS http://127.0.0.1:3202/version)"
  node_exec -e 'const v=JSON.parse(process.argv[1]),m=require(process.argv[2]);if(v.gitSha!==m.gitSha||v.schemaVersion!==m.schemaVersion)process.exit(1)' "$version" "$DX_ROOT/current/release-manifest.json"
fi
printf '%s\n' "$evidence" > "$source_dir/worker-evidence"
echo prepared > "$evidence/phase"
next_action="$(node_exec "$policy" next-action "$previous" "$sha" "$schema_current" "$status")"
if [[ "$next_action" == verify ]]; then
  pending_status=0
  node_exec "$tool_root/scripts/deploy/acceptance-pm2-activation.mjs" pending "$sha" "$previous" "$evidence" >/dev/null || pending_status=$?
  [[ "$pending_status" == 0 || "$pending_status" == 10 ]] || die 'Pending Acceptance activation evidence is invalid'
  if [[ "$pending_status" == 0 ]]; then
    if ! { node_exec "$tool_root/scripts/deploy/verify-acceptance-update.mjs" "$candidate" "$source_dir/production-runtime.json" && pm2 save && node_exec "$tool_root/scripts/deploy/acceptance-runtime-state.mjs" "$sha" saved > "$evidence/saved-runtime.json"; }; then
      if node_exec "$tool_root/scripts/deploy/acceptance-pm2-activation.mjs" halt "$sha" "$previous" "$evidence"; then
        echo failed-runtime-stopped > "$evidence/phase"
      else
        echo failed-runtime-state-unverified > "$evidence/phase"
      fi
      exit 1
    fi
    node_exec "$tool_root/scripts/deploy/acceptance-pm2-activation.mjs" complete "$sha" "$previous" "$evidence"
  else
    node_exec "$tool_root/scripts/deploy/verify-acceptance-update.mjs" "$candidate" "$source_dir/production-runtime.json"
    node_exec "$tool_root/scripts/deploy/acceptance-runtime-state.mjs" "$sha" saved > "$evidence/saved-runtime.json"
  fi
  echo "Already current and healthy: $sha"
  exit 10
fi
if [[ "$next_action" == activate ]]; then
  # A failed activation already committed the schema and selected this generation.
  # Resume only this verified candidate, without another backup or migration.
  assert_active_release "$sha"
  echo activation-retry > "$evidence/phase"
  exit 11
fi
bash scripts/deploy/install-release.sh "$sha" "$candidate"
echo 'Candidate prepared; API has not been stopped. Owner-role preflight is next.'
