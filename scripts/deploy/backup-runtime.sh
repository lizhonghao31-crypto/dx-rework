#!/usr/bin/env bash
# Resolve the actual running DX Rework layout for backup operations.
# Production deploy-ecs uses current -> source; packaged PR-17 releases use active/generations.
# Backups follow current and never mutate deployment aliases.
set -euo pipefail

backup_manifest_field() {
  local file="$1" key="$2"
  python3 - "$file" "$key" <<'PY'
import json
import sys
path, key = sys.argv[1:]
value = json.load(open(path, encoding="utf-8")).get(key)
if not isinstance(value, (str, int, float, bool)) or value == "":
    raise SystemExit(2)
print(value)
PY
}

resolve_backup_runtime() {
  local current="$DX_ROOT/current" frontend_current="$DX_ROOT/frontend/current"
  local api_manifest web_manifest migration_manifest latest_schema generation
  local source_owner source_head source_status

  require_command readlink
  require_command python3
  [[ -L "$current" && -d "$current" ]] || die 'backup runtime current alias is missing or broken'
  [[ -L "$frontend_current" && -d "$frontend_current" ]] || die 'backup runtime frontend alias is missing or broken'

  active_api="$(readlink -e "$current")"
  active_frontend="$(readlink -e "$frontend_current")"
  [[ -n "$active_api" && -n "$active_frontend" ]] || die 'backup runtime aliases cannot be resolved'
  active_api="$(assert_safe_path "$active_api")"
  active_frontend="$(assert_safe_path "$active_frontend")"

  if [[ "$active_api" == "$DX_ROOT/source" ]]; then
    active_mode=source
    require_command git
    api_manifest="$active_api/release-manifest.json"
    [[ -f "$api_manifest" && ! -L "$api_manifest" ]] || die 'source deployment release manifest is missing or unsafe'
    active_sha="$(backup_manifest_field "$api_manifest" gitSha)"
    require_sha "$active_sha"
    source_owner="$(stat -c %U "$active_api")"
    if [[ "$(id -un)" == "$source_owner" ]]; then
      source_head="$(git -C "$active_api" rev-parse HEAD)"
      source_status="$(git -C "$active_api" status --porcelain)"
    else
      require_command runuser
      source_head="$(runuser -u "$source_owner" -- git -C "$active_api" rev-parse HEAD)"
      source_status="$(runuser -u "$source_owner" -- git -C "$active_api" status --porcelain)"
    fi
    [[ "$source_head" == "$active_sha" ]] ||
      die 'source checkout does not match deployed release'
    [[ -z "$source_status" ]] ||
      die 'source checkout is dirty; backup refuses unverified scripts'
    [[ "$active_frontend" == "$DX_ROOT/frontend/source-releases/$active_sha" ]] ||
      die 'source API and frontend releases disagree'
  elif [[ "$active_api" == "$DX_ROOT/releases/"* ]]; then
    active_mode=generation
    active_sha="$(basename "$active_api")"
    require_sha "$active_sha"
    [[ "$(readlink "$current")" == "$DX_ROOT/active/api" ]] || die 'generation API current alias is invalid'
    [[ "$(readlink "$frontend_current")" == "$DX_ROOT/active/frontend" ]] || die 'generation frontend current alias is invalid'
    [[ -L "$DX_ROOT/active" ]] || die 'generation active alias is missing'
    generation="$(readlink -e "$DX_ROOT/active")"
    [[ "$generation" == "$DX_ROOT/generations/$active_sha" ]] || die 'generation active alias does not match current release'
    [[ "$(readlink -e "$generation/api")" == "$active_api" ]] || die 'generation API target mismatch'
    [[ "$(readlink -e "$generation/frontend")" == "$active_frontend" ]] || die 'generation frontend target mismatch'
    api_manifest="$active_api/release-manifest.json"
    [[ -f "$api_manifest" && ! -L "$api_manifest" ]] || die 'generation API release manifest is missing or unsafe'
  else
    die 'backup runtime current alias points to an unsupported deployment layout'
  fi

  web_manifest="$active_frontend/release-manifest.json"
  migration_manifest="$active_api/apps/api/src/platform/migration-manifest.json"
  [[ -f "$web_manifest" && ! -L "$web_manifest" ]] || die 'backup runtime frontend release manifest is missing or unsafe'
  [[ -f "$migration_manifest" && ! -L "$migration_manifest" ]] || die 'backup runtime migration manifest is missing or unsafe'
  [[ "$(backup_manifest_field "$api_manifest" gitSha)" == "$active_sha" ]] || die 'backup runtime API manifest SHA mismatch'
  [[ "$(backup_manifest_field "$web_manifest" gitSha)" == "$active_sha" ]] || die 'backup runtime frontend manifest SHA mismatch'

  latest_schema="$(python3 - "$migration_manifest" <<'PY'
import json
import sys
m = json.load(open(sys.argv[1], encoding="utf-8"))
latest = m.get("migrations", [])[-1] if m.get("migrations") else None
if not isinstance(latest, dict) or not latest.get("version"):
    raise SystemExit(2)
print(latest["version"])
PY
)"
  [[ "$(backup_manifest_field "$api_manifest" schemaVersion)" == "$latest_schema" ]] || die 'backup runtime API schema does not match migration manifest'
  [[ "$(backup_manifest_field "$web_manifest" schemaVersion)" == "$latest_schema" ]] || die 'backup runtime frontend schema does not match migration manifest'
}
