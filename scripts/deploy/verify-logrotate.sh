#!/usr/bin/env bash
set -euo pipefail
root="$(mktemp -d)"; trap 'rm -rf "$root"' EXIT; mkdir -p "$root/logs"; echo before > "$root/logs/api.log"; sed "s#/opt/dx-rework#$root#g;s/su root root/su $(id -un) $(id -gn)/" infra/logrotate/dx-rework > "$root/config"; logrotate -d -s "$root/state" "$root/config"; logrotate -f -s "$root/state" "$root/config"; echo after >> "$root/logs/api.log"; test -s "$root/logs/api.log"; find "$root/logs" -name 'api.log-*' -print -quit|grep -q .; echo '{"status":"pass","message":"isolated logrotate verified and log remains writable"}'
