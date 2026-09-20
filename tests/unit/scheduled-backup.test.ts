import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const read = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");

describe("OPS-03 scheduled PostgreSQL backups", () => {
  it("runs from the active release, isolates retention, and writes durable health evidence", async () => {
    const script = await read("scripts/deploy/run-scheduled-postgres-backup.sh");
    expect(script).toContain('backup_root="$DX_ROOT/backups/postgres/daily"');
    expect(script).toContain('source "$(dirname "$0")/backup-runtime.sh"');
    expect(script).toContain("resolve_backup_runtime");
    expect(script).toContain('if [[ "$active_mode" == source ]]');
    expect(script).toContain("verify-current");
    expect(script).toContain("keep_count=14");
    expect(script).toContain('release_lock="$(assert_safe_path "$DX_ROOT/locks/release.lock")"');
    expect(script).toContain("flock -w 1800 7");
    expect(script).toContain("daily-backup-last-success.json");
    expect(script).toContain("daily-backup-last-failure.json");
    expect(script).toContain("sha256sum -c --strict SHA256SUMS");
    expect(script).toContain("pg_exec pg_restore --list");
    expect(script).toContain("awk 'NR==1");
    expect(script).not.toContain("head -1");
    expect(script).toContain('rm -rf -- "$stale"');
    expect(script).not.toContain("/opt/daxing-");
  });

  it("checks staleness and unresolved failures independently of the backup run", async () => {
    const script = await read("scripts/deploy/check-scheduled-postgres-backup.sh");
    expect(script).toContain("max_age_seconds=108000");
    expect(script).toContain('"$failure_file" -nt "$success_file"');
    expect(script).toContain("sha256sum -c --strict SHA256SUMS");
    expect(script).toContain("pg_exec pg_restore --list");
    expect(script).toContain("for required in COMPLETE SHA256SUMS database.dump metadata.json");
  });

  it("uses persistent Shanghai timers and does not auto-install them during routine release", async () => {
    const backupTimer = await read("infra/systemd/dx-rework-postgres-backup.timer");
    const healthTimer = await read("infra/systemd/dx-rework-postgres-backup-health.timer");
    const installer = await read("scripts/deploy/install-postgres-backup-timer.sh");
    const packageRelease = await read("scripts/deploy/package-release.sh");
    const backupService = await read("infra/systemd/dx-rework-postgres-backup.service");
    const healthService = await read("infra/systemd/dx-rework-postgres-backup-health.service");

    expect(backupTimer).toContain("OnCalendar=*-*-* 23:30:00 Asia/Shanghai");
    expect(backupTimer).toContain("Persistent=true");
    expect(healthTimer).toContain("OnCalendar=*-*-* 08:30:00 Asia/Shanghai");
    expect(installer).toContain('source "$(dirname "$0")/backup-runtime.sh"');
    expect(installer).toContain("resolve_backup_runtime");
    expect(installer).not.toContain("current_generation_sha");
    expect(installer).not.toContain("assert_active_release");
    expect(installer).toContain("systemctl start dx-rework-postgres-backup.service");
    expect(installer).toContain("systemctl enable --now dx-rework-postgres-backup.timer");
    expect(installer).toContain("systemctl enable --now dx-rework-postgres-backup-health.timer");
    expect(packageRelease).toContain("infra/systemd/dx-rework-postgres-backup");
    expect(packageRelease).not.toContain("systemctl enable");
    expect(backupService).toContain("ExecStart=/usr/bin/bash /opt/dx-rework/current/scripts/deploy/run-scheduled-postgres-backup.sh");
    expect(healthService).toContain("ExecStart=/usr/bin/bash /opt/dx-rework/current/scripts/deploy/check-scheduled-postgres-backup.sh");
  });
});
