#!/usr/bin/env bash
# A full remote object store, independent of the production partial clone.
set -Eeuo pipefail
[[ $# == 2 && "$(id -u)" == 0 ]] || exit 64
sha="$1"; snapshot="$2"
[[ "$sha" =~ ^[0-9a-f]{40}$ && "$snapshot" == /tmp/dx-acceptance-source.* && -d "$snapshot" && ! -L "$snapshot" ]]
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
git_remote archive "$sha" | tar -x -C "$snapshot"
