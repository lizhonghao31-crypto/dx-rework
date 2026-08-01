#!/usr/bin/env bash
set -euo pipefail
readonly sha=0123456789abcdef0123456789abcdef01234567
rm -rf apps/web/dist
VITE_BASE_PATH=/pr-999/ npm run build:packages
VITE_BASE_PATH=/pr-999/ npm run build --workspace @dx-rework/web
node scripts/preview/build.mjs 999 "$sha"
(cd apps/web/dist && sha256sum --check SHA256SUMS)
node -e 'const m=require("./apps/web/dist/preview-manifest.json"); if(m.headSha!==process.argv[1]||m.basePath!=="/pr-999/")process.exit(1)' "$sha"
rg -q '/pr-999/assets/' apps/web/dist/index.html
test -f apps/web/dist/ui/management/index.html
test -f apps/web/dist/system/foundation/index.html
if node -e 'import("./scripts/preview/lib.mjs").then(m=>m.assertSafeRemoteDirectory("/opt/dx-rework/previews/*"))' 2>/dev/null; then exit 1; fi
echo "dry-run passed: PR 999, $sha"
