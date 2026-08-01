#!/usr/bin/env bash
set -euo pipefail
readonly sha=0123456789abcdef0123456789abcdef01234567
readonly run_id=999999
rm -rf apps/web/dist
VITE_BASE_PATH=/pr-999/ npm run build:packages
VITE_BASE_PATH=/pr-999/ npm run build --workspace @dx-rework/web
node scripts/preview/build.mjs 999 "$sha" "$run_id"
(cd apps/web/dist && sha256sum --check SHA256SUMS)
node -e 'const m=require("./apps/web/dist/preview-manifest.json"); if(m.headSha!==process.argv[1]||m.githubRunId!==process.argv[2]||m.basePath!=="/pr-999/")process.exit(1)' "$sha" "$run_id"
if find apps/web/dist -type l -print -quit | grep -q .; then echo "symlinks are forbidden in preview artifacts" >&2; exit 1; fi
rg -q '/pr-999/assets/' apps/web/dist/index.html
test -f apps/web/dist/ui/management/index.html
test -f apps/web/dist/system/foundation/index.html
if node -e 'import("./scripts/preview/lib.mjs").then(m=>m.assertSafeRemoteDirectory("/opt/dx-rework/previews/*"))' 2>/dev/null; then exit 1; fi
node scripts/preview/status.mjs 999 "$sha" "$run_id" built-disabled "" /tmp/dx-rework-preview-comment.md >/dev/null
rg -q '部署未启用' /tmp/dx-rework-preview-comment.md
echo "dry-run passed: PR 999, $sha, run $run_id"
