#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/lib.sh"
source "$(dirname "$0")/backup-runtime.sh"

[[ "$(id -u)" == 0 ]] || die 'backup timer installation requires root'
resolve_backup_runtime

unit_source="$active_api/infra/systemd"
for unit in   dx-rework-postgres-backup.service   dx-rework-postgres-backup.timer   dx-rework-postgres-backup-health.service   dx-rework-postgres-backup-health.timer; do
  [[ -f "$unit_source/$unit" && ! -L "$unit_source/$unit" ]] ||
    die "backup systemd unit missing: $unit"
  install -m 0644 "$unit_source/$unit" "/etc/systemd/system/$unit"
done

install -d -o dxrework -g dxrework -m 0700   "$DX_ROOT/backups/postgres/daily"   "$DX_ROOT/evidence/ops03"   "$DX_ROOT/locks"

systemctl daemon-reload
systemd-analyze verify   /etc/systemd/system/dx-rework-postgres-backup.service   /etc/systemd/system/dx-rework-postgres-backup.timer   /etc/systemd/system/dx-rework-postgres-backup-health.service   /etc/systemd/system/dx-rework-postgres-backup-health.timer

systemctl start dx-rework-postgres-backup.service
systemctl enable --now dx-rework-postgres-backup.timer
systemctl enable --now dx-rework-postgres-backup-health.timer

runuser -u dxrework -- /usr/bin/bash "$DX_ROOT/current/scripts/deploy/check-scheduled-postgres-backup.sh"

systemctl --no-pager --full status dx-rework-postgres-backup.timer
systemctl --no-pager --full status dx-rework-postgres-backup-health.timer
safe_log pass 'daily PostgreSQL backup timers installed and initial backup verified'
