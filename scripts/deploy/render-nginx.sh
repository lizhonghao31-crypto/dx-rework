#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/lib.sh"; [[ $# == 2 ]] || die 'usage: render-nginx.sh TEMPLATE OUTPUT'
: "${DX_REWORK_SERVER_NAME:?}" "${DX_REWORK_TLS_CERT:?}" "${DX_REWORK_TLS_KEY:?}"
[[ "$DX_REWORK_SERVER_NAME" =~ ^[A-Za-z0-9.-]+$ && "$DX_REWORK_SERVER_NAME" != staging-api.dxerp.org.cn ]] || die 'invalid or mixed server name'
for f in "$DX_REWORK_TLS_CERT" "$DX_REWORK_TLS_KEY"; do [[ -f "$f" && ! -L "$f" ]] || die 'TLS path must be a regular non-symlink file'; done
node - "$1" "$2" "$DX_REWORK_SERVER_NAME" "$DX_REWORK_TLS_CERT" "$DX_REWORK_TLS_KEY" <<'JS'
const fs=require('fs');const [i,o,n,c,k]=process.argv.slice(2);let s=fs.readFileSync(i,'utf8').replaceAll('__DX_REWORK_SERVER_NAME__',n).replaceAll('__DX_REWORK_TLS_CERT__',c).replaceAll('__DX_REWORK_TLS_KEY__',k);if(/__[A-Z0-9_]+__/.test(s))throw Error('unrendered placeholder');fs.writeFileSync(o,s,{mode:0o640});
JS
grep -q 'listen 443 ssl' "$2"; ! grep -Eq '__[A-Z0-9_]+__' "$2" || die 'unrendered placeholder'
