#!/usr/bin/env bash
set -euo pipefail; source "$(dirname "$0")/lib.sh"; [[ $# == 2 ]] || die 'usage: create-transfer-bundle.sh BUNDLE OUTPUT_TAR'
bundle="$(realpath "$1")"; output="$2"; [[ -d "$bundle" && ! -L "$bundle" && ! -e "$output" ]] || die 'unsafe transfer paths'
find "$bundle" -type l -print -quit | grep -q . && die 'transfer bundle contains symlink'
[[ -f "$bundle/release-manifest.json" && -f "$bundle/SHA256SUMS" && -d "$bundle/api" && -d "$bundle/frontend" ]] || die 'bundle allowlist requires api/frontend and manifests'
verify_sums "$bundle/api"; verify_sums "$bundle/frontend"; verify_sums "$bundle"
bad="$(find "$bundle" -type f \( -name '.env' -o -name '.env.*' -o -name 'id_rsa' -o -name 'id_ed25519' -o -name 'id_ecdsa' -o -name 'id_dsa' -o -name '*.pem' -o -name '*.key' -o -name '*.p12' -o -name '*.pfx' \) -print -quit)"; [[ -z "$bad" ]] || die 'transfer bundle contains sensitive input'
node --input-type=module -e 'import {findPotentialSecrets} from "./scripts/secret-scan.mjs";const f=await findPotentialSecrets(process.argv[1],new Set([".git","node_modules","dist"]));if(f.length)process.exit(1)' "$bundle" || die 'transfer bundle secret signature scan failed'
tar --sort=name --owner=0 --group=0 --numeric-owner --mtime='UTC 1970-01-01' -C "$(dirname "$bundle")" -czf "$output" "$(basename "$bundle")"
(cd "$(dirname "$output")" && sha256sum "$(basename "$output")" > "$(basename "$output").sha256")
