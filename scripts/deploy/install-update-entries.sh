#!/usr/bin/env bash
# One explicit installation binds both independently audited branch revisions.
set -Eeuo pipefail
[[ "$(id -u)" == 0 && $# == 4 ]] || { echo 'Usage: install-update-entries.sh MAIN_SHA ACCEPTANCE_SHA APPROVED_NODE_BINARY EXISTING_DEDICATED_NGINX_CONFIG' >&2; exit 64; }
main_sha="$1"; acceptance_sha="$2"; node_binary="$3"; nginx_config="$4"
[[ "$main_sha" =~ ^[0-9a-f]{40}$ && "$acceptance_sha" =~ ^[0-9a-f]{40}$ ]]
source_root="$(cd "$(dirname "$0")/../.." && pwd -P)"
owner="$(stat -c %U "$source_root")"
[[ "$(runuser -u "$owner" -- git -C "$source_root" rev-parse HEAD)" == "$main_sha" && -z "$(runuser -u "$owner" -- git -C "$source_root" status --porcelain)" ]]
exec 8>/run/lock/dx-release-tools-install.lock
flock -n 8 || { echo 'Tool installation is already running.' >&2; exit 1; }
repository="$(mktemp -d /tmp/dx-tools-git.XXXXXX)"
trap 'rm -rf -- "$repository"' EXIT
chown dxrework:dxrework "$repository"
remote_git() { (cd /; runuser -u dxrework -- git -C "$repository" "$@"); }
remote_git init --quiet
remote_git config core.sshCommand 'ssh -i /home/dxrework/.ssh/github_dx_rework -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=15'
remote_git remote add origin git@github.com:lizhonghao31-crypto/dx-rework.git
timeout 300 runuser -u dxrework -- git -C "$repository" fetch --quiet --no-tags origin refs/heads/main:refs/remotes/origin/main refs/heads/release/digital-production-v1:refs/remotes/origin/release/digital-production-v1
remote_git merge-base --is-ancestor "$main_sha" refs/remotes/origin/main
remote_git merge-base --is-ancestor "$acceptance_sha" refs/remotes/origin/release/digital-production-v1
remote_git fsck --full --no-reflogs >/dev/null
remote_git cat-file -e "$acceptance_sha:scripts/dx-update.sh"
remote_git cat-file -e "$acceptance_sha:scripts/deploy/verify-tool-refresh.py"
remote_git checkout --quiet --detach "$main_sha"
bash "$repository/scripts/deploy/install-online-entry.sh" "$node_binary" "$nginx_config"
remote_git checkout --quiet --detach "$acceptance_sha"
bash "$repository/scripts/dx-acceptance.sh" install
echo 'UPDATE_ENTRIES_INSTALLED; tools only, no application deployment. First main conversion uses dx-rework-maintenance-update. Daily commands: dx-rework-update main | dx-rework-update acceptance'
