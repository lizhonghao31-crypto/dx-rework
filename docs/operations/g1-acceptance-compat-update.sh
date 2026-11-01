#!/usr/bin/env bash
# Reviewed G1 handoff: explicit phases; existing installer/controller remain the only operators.
set -Eeuo pipefail
umask 077
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
[[ $# == 2 && "$2" =~ ^[0-9a-f]{40}$ ]] || { echo 'Usage: bash g1-acceptance-compat-update.sh check|install|diagnose|update MERGED_RELEASE_SHA' >&2; exit 64; }
phase="$1"; target_sha="$2"
case "$phase" in check|install|diagnose|update) ;; *) exit 64;; esac
[[ "$(id -u)" == 0 ]] || { echo 'Run the reviewed handoff as root.' >&2; exit 1; }
src=/opt/dx-rework/source
tools=/opt/dx-rework-acceptance-tools
checkout='';scratch=''
git_source(){ runuser -u dxrework -- env -i HOME=/home/dxrework USER=dxrework PATH="$PATH" git -C "$src" "$@"; }
origin="$(git_source remote get-url origin)"
[[ "$origin" == git@github.com:lizhonghao31-crypto/dx-rework.git || "$origin" == https://github.com/lizhonghao31-crypto/dx-rework.git ]]
git_source fetch --quiet origin refs/heads/release/digital-production-v1:refs/remotes/origin/release/digital-production-v1
[[ "$(git_source rev-parse refs/remotes/origin/release/digital-production-v1)" == "$target_sha" ]] || { echo 'STOP: target is not the current frozen merged release tip.' >&2; exit 1; }
cmp <(git_source show "$target_sha:docs/operations/g1-acceptance-compat-update.sh") "${BASH_SOURCE[0]}" || { echo 'STOP: use the original handoff script from the approved target.' >&2; exit 1; }
cleanup(){
  local rc=$?
  if [[ -n "$checkout" ]]; then git_source worktree remove "$checkout" || echo "Retained installer checkout: $checkout" >&2; fi
  if [[ -n "$scratch" ]]; then rmdir "$scratch" 2>/dev/null || true; fi
  return "$rc"
}
trap cleanup EXIT
if [[ "$phase" == check || "$phase" == install ]]; then
  scratch="$(mktemp -d /tmp/dx-g1-compat.XXXXXX)"
  chown dxrework:dxrework "$scratch"
  checkout="$scratch/source"
  git_source worktree add --quiet --detach "$checkout" "$target_sha"
  echo "READ_ONLY_TARGET_CHECK candidate=$target_sha proposed_tool=$target_sha"
  runuser -u dxrework -- env -i HOME=/home/dxrework USER=dxrework PATH="$PATH" bash -c '
    set -euo pipefail
    source "$1/scripts/deploy/lib.sh"
    load_node_config
    node_exec "$1/scripts/check-main-release-compat.mjs" --intent acceptance --repo "$2" --candidate-ref "$3" --tool-ref "$3"
  ' _ "$checkout" "$src" "$target_sha"
  if [[ "$phase" == check ]]; then echo 'CHECK_FINISHED: no tool installation, migration or service update performed.'; exit 0; fi
  # Explicit reviewed installation; never relax the old data-only refresh validator.
  bash "$checkout/scripts/dx-acceptance.sh" install
fi
[[ -f "$tools/$target_sha/TOOL_SHA" && "$(cat "$tools/$target_sha/TOOL_SHA")" == "$target_sha" ]]
expected="$(printf '#!/usr/bin/env bash\nexec bash %q "$@"\n' "$tools/$target_sha/scripts/dx-acceptance.sh")"
[[ -f /usr/local/bin/dx-acceptance && ! -L /usr/local/bin/dx-acceptance && "$(cat /usr/local/bin/dx-acceptance)" == "$expected" ]] || { echo 'STOP: matching immutable tool is not installed; run the reviewed install phase.' >&2; exit 1; }
echo "INSTALLED_TOOL_VERIFIED tool=$target_sha candidate=$target_sha"
case "$phase" in
  install) echo 'INSTALL_FINISHED: tool only; next run diagnose with the same frozen SHA.';;
  diagnose) bash /usr/local/bin/dx-acceptance diagnose "$target_sha";;
  update) bash /usr/local/bin/dx-acceptance update "$target_sha";;
esac
