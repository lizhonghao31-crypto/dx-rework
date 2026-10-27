#!/usr/bin/env bash
# A full remote object store, independent of the production partial clone.
set -Eeuo pipefail
[[ $# == 3 && "$(id -u)" == 0 ]] || exit 64
sha="$1"; snapshot="$2"; mode="$3"
[[ "$sha" =~ ^[0-9a-f]{40}$ && "$snapshot" == /tmp/dx-acceptance-source.* && -d "$snapshot" && ! -L "$snapshot" ]]
[[ "$mode" == update || "$mode" == diagnose ]]
tool_root="$(cd "$(dirname "$0")/../.." && pwd -P)"
metadata="$snapshot/.acceptance-preflight"
[[ -d "$metadata" && ! -L "$metadata" && -f "$metadata/identity-first.json" ]]
repository="$(mktemp -d /tmp/dx-update-git.XXXXXX)"
trap 'rm -rf -- "$repository"' EXIT
chown dxrework:dxrework "$repository"
git_remote() { runuser -u dxrework -- git -C "$repository" "$@"; }
git_remote init --quiet
git_remote config core.sshCommand 'ssh -i /home/dxrework/.ssh/github_dx_rework -o IdentitiesOnly=yes'
git_remote remote add origin git@github.com:lizhonghao31-crypto/dx-rework.git
git_remote fetch --quiet --no-tags origin refs/heads/release/digital-production-v1:refs/remotes/origin/release/digital-production-v1
git_remote merge-base --is-ancestor "$sha" refs/remotes/origin/release/digital-production-v1
git_remote fsck --full --no-reflogs >/dev/null
[[ -z "$(git_remote ls-tree --name-only "$sha" -- .acceptance-preflight acceptance-identity.json production-runtime.json production-history.json worker-evidence)" ]] || { echo 'Source collides with reserved update evidence.' >&2; exit 1; }
git_remote ls-tree -rl "$sha" > "$metadata/tree-sizes.txt"
git_remote rev-parse "$sha^{tree}" > "$metadata/tree-sha"
storage=(); phase=diagnose-archive
if [[ "$mode" == update ]]; then
  phase=archive
  python3 "$tool_root/scripts/deploy/inspect-acceptance-storage.py" "$metadata/identity-first.json" "$metadata/storage-archive.json"
  storage=(--storage "$metadata/storage-archive.json")
fi
python3 "$tool_root/scripts/deploy/acceptance-capacity.py" "$phase" "$snapshot" "$tool_root" "$sha" --tree "$metadata/tree-sizes.txt" "${storage[@]}" | tee "$metadata/capacity-$phase.json"
git_remote archive "$sha" | tar -x -C "$snapshot"
