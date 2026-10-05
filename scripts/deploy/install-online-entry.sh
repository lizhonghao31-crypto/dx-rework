#!/usr/bin/env bash
# Explicit one-time installation from the final audited immutable checkout.
set -Eeuo pipefail
[[ "$(id -u)" == 0 && $# == 2 ]] || { echo 'Usage: install-online-entry.sh APPROVED_NODE_BINARY EXISTING_DEDICATED_NGINX_CONFIG' >&2; exit 64; }
export DX_REWORK_ROOT=/opt/dx-rework
source_root="$(cd "$(dirname "$0")/../.." && pwd -P)"
source "$source_root/scripts/deploy/lib.sh"
node_binary="$(realpath "$1")"
state=/opt/dx-rework-release-state
if [[ -d "$state" && ! -L "$state" && "$(stat -c %U "$state")" == root && "$2" == "$(cat "$state/nginx-config")" ]]; then config="$2"; else config="$(realpath "$2")"; fi
[[ "$config" == /etc/nginx/* && "$config" != *..* && -f "$config" && "$(stat -c %U "$config")" == root ]]
if [[ -L "$config" ]]; then [[ "$(readlink -f "$config")" == "$state/"* ]]; fi
[[ -f "$node_binary" && ! -L "$node_binary" && -x "$node_binary" && "$(stat -c %U "$node_binary")" == root ]]
assert_root_node "$node_binary"
owner="$(stat -c %U "$source_root")"
git_source() { runuser -u "$owner" -- git -C "$source_root" "$@"; }
sha="$(git_source rev-parse HEAD)"
[[ "$sha" =~ ^[0-9a-f]{40}$ && -z "$(git_source status --porcelain)" ]]
[[ -f /opt/dx-rework/locks/release.lock && ! -L /opt/dx-rework/locks/release.lock ]]
exec 9>/opt/dx-rework/locks/release.lock
flock -n 9 || { echo 'Deployment lock is held; installation did not start.' >&2; exit 1; }
nginx -t
tools=/opt/dx-rework-release-tools
if [[ -e "$state" ]]; then
  [[ -d "$state" && ! -L "$state" && "$(stat -c %U "$state")" == root && "$(stat -c %a "$state")" == 700 ]]
  [[ "$(cat "$state/node-binary")" == "$node_binary" && "$(cat "$state/nginx-config")" == "$config" ]]
  [[ -f "$state/original-deploy-entry" && -f "$state/active.json" && -f "$state/nginx-template.conf" ]]
else
  baseline="$(curl --noproxy '*' --connect-timeout 2 --max-time 3 -fsS http://127.0.0.1:3201/version | "$node_binary" -e 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>process.stdout.write(JSON.parse(s).gitSha))')"
  [[ "$baseline" =~ ^[0-9a-f]{40}$ ]]
fi
install -d -o root -g root -m 0755 "$tools"
[[ ! -L "$tools" && "$(stat -c %U "$tools")" == root ]]
staging="$(mktemp -d "$tools/.install.XXXXXX")"
trap '[[ -z "${staging:-}" ]] || rm -rf -- "$staging"' EXIT
git_source archive "$sha" | tar -x -C "$staging"
chown -R root:root "$staging"
chmod -R go-w "$staging"
chmod 0755 "$staging"
if [[ -e "$tools/$sha" ]]; then
  [[ -d "$tools/$sha" && ! -L "$tools/$sha" ]]
  diff -qr --exclude=node_modules "$staging" "$tools/$sha" >/dev/null
  rm -rf -- "$staging"
else
  mv -T "$staging" "$tools/$sha"
fi
staging=''
# Only delegated dxrework SQL helpers load pg. Root helpers import Node builtins
# exclusively; root never loads executable dependencies from this user runtime.
if [[ ! -e "$tools/$sha/node_modules" && ! -L "$tools/$sha/node_modules" ]]; then
  ln -s /opt/dx-rework/current/node_modules "$tools/$sha/node_modules"
fi
[[ -L "$tools/$sha/node_modules" && "$(readlink "$tools/$sha/node_modules")" == /opt/dx-rework/current/node_modules ]]
if [[ ! -e "$state" ]]; then
  staging="$(mktemp -d "$tools/.state-install.XXXXXX")"
  chmod 0700 "$staging"
  cp "$config" "$staging/nginx-template.conf"
  printf '%s\n' "$node_binary" > "$staging/node-binary"
  printf '%s\n' "$config" > "$staging/nginx-config"
  "$node_binary" -e 'require("fs").writeFileSync(process.argv[1],JSON.stringify({sha:process.argv[2],port:3201})+"\n",{mode:0o600})' "$staging/active.json" "$baseline"
  cp "$config" "$staging/original-nginx.conf"
  cp /usr/local/bin/dx-rework-deploy "$staging/original-deploy-entry"
  printf '%s\n' installed-unconverted > "$staging/phase"
  mv -T "$staging" "$state"
  staging=''
fi
# Installing tools is distinct from converting the old source runtime. Leave
# nginx and running requests untouched; the fixed maintenance entry converts it.
launcher="$(mktemp /usr/local/bin/.dx-rework-deploy.XXXXXX)"
printf '#!/usr/bin/env bash\nexec bash %q "$@"\n' "$tools/$sha/scripts/deploy/update-main-online.sh" > "$launcher"
chmod 0755 "$launcher"
mv -Tf "$launcher" /usr/local/bin/dx-rework-deploy
launcher="$(mktemp /usr/local/bin/.dx-rework-maintenance-update.XXXXXX)"
printf '#!/usr/bin/env bash\nexec bash %q "$@"\n' "$tools/$sha/scripts/deploy/update-main-maintenance.sh" > "$launcher"
chmod 0755 "$launcher"
mv -Tf "$launcher" /usr/local/bin/dx-rework-maintenance-update
echo 'TOOLS_INSTALLED; first conversion requires dx-rework-maintenance-update; later same-schema updates use dx-rework-update main'
