#!/usr/bin/env bash
set -Eeuo pipefail
[[ $# == 2 ]] || { echo 'usage: prepare-build-dependencies.sh CANDIDATE CURRENT' >&2; exit 64; }
candidate="$1"; current="$2"
[[ "$candidate" == /tmp/dx-main-update.* && -d "$candidate" && ! -L "$candidate" && "$(realpath "$candidate")" == "$candidate" ]]
[[ "$(realpath "$current")" != "$candidate" && ! -e "$candidate/node_modules" && ! -L "$candidate/node_modules" ]]
helper="$(cd "$(dirname "$0")" && pwd -P)/dependency-bins.mjs"
cd "$candidate"
verify_dependencies() {
  npm ls --depth=0 && node "$helper" verify-build "$candidate"
}
reused=false
if cmp -s package-lock.json "$current/package-lock.json" && [[ -d "$current/node_modules" ]]; then
  mkdir node_modules
  cp -a "$current/node_modules/." node_modules/
  # Rebind workspace packages only in the disposable candidate source tree.
  node - <<'JS'
const fs=require('fs'),path=require('path');
const names={contracts:'packages/contracts',config:'packages/config',domain:'packages/domain',ui:'packages/ui',api:'apps/api',web:'apps/web'};
fs.mkdirSync('node_modules/@dx-rework',{recursive:true});
for(const [name,target] of Object.entries(names)){const p=`node_modules/@dx-rework/${name}`;fs.rmSync(p,{recursive:true,force:true});fs.symlinkSync(path.relative(path.dirname(p),target),p,'dir');}
JS
  # Recreate flattened CLI launchers without lifecycle scripts or network work.
  if { timeout 120 npm rebuild --ignore-scripts --bin-links=true --offline --no-audit --no-fund && verify_dependencies; } > dependency-check.log 2>&1; then
    reused=true
  else
    rm -rf -- node_modules
  fi
fi
if [[ "$reused" == false ]]; then
  timeout 600 npm ci --prefer-offline --no-audit --no-fund
  verify_dependencies >> dependency-check.log 2>&1 || { echo 'candidate build dependencies are unhealthy' >&2; exit 1; }
fi
