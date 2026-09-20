import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("PostgreSQL backup manifest", () => {
  it("checksums relocation-safe dump and metadata basenames before COMPLETE", async () => {
    const script = await readFile(new URL("../../scripts/backup-postgres.sh", import.meta.url), "utf8");
    expect(script).toContain('cd "$tmp"');
    expect(script).toContain("sha256sum database.dump metadata.json > SHA256SUMS");
    expect(script).toContain("sha256sum -c --strict SHA256SUMS");
    expect(script).not.toMatch(/sha256sum\s+"?\$final/);
    expect(script.indexOf('sha256sum -c --strict SHA256SUMS')).toBeLessThan(
      script.indexOf(': > "$tmp/COMPLETE"'),
    );
  });

  it("derives backup and restore identities without privileged PostgreSQL server metadata", async () => {
    const lib = await readFile(new URL("../../scripts/deploy/lib.sh", import.meta.url), "utf8");
    const backup = await readFile(new URL("../../scripts/backup-postgres.sh", import.meta.url), "utf8");
    const restore = await readFile(new URL("../../scripts/restore-postgres.sh", import.meta.url), "utf8");
    const fullGate = await readFile(new URL("../../.github/workflows/full-gate.yml", import.meta.url), "utf8");

    expect(lib).toContain("database_connection_identity()");
    expect(lib).toContain('select current_database()');
    expect(lib).not.toContain("inet_server_addr()");
    expect(lib).not.toContain("inet_server_port()");
    expect(backup).toContain('database_connection_fingerprint "$DATABASE_URL"');
    expect(restore).toContain('database_connection_identity "$DX_REWORK_RESTORE_DATABASE_URL"');
    expect(backup).not.toContain("inet_server_addr()");
    expect(restore).not.toContain("inet_server_addr()");
    expect(fullGate).toContain('target_fp="$(database_connection_fingerprint "$target_url")"');
    expect(fullGate).not.toContain("inet_server_addr()");
  });
  it("pins one PostgreSQL client toolchain and rejects a dump client older than the server", async () => {
    const lib = await readFile(new URL("../../scripts/deploy/lib.sh", import.meta.url), "utf8");
    const backup = await readFile(new URL("../../scripts/backup-postgres.sh", import.meta.url), "utf8");
    const restore = await readFile(new URL("../../scripts/restore-postgres.sh", import.meta.url), "utf8");
    const deployExample = await readFile(new URL("../../docs/operations/pr-17-deploy.env.example", import.meta.url), "utf8");

    expect(lib).toContain("DX_REWORK_PG_BIN_DIR");
    expect(lib).toContain("approved_pg_bin_dir()");
    expect(lib).toContain("pg_tool_path()");
    expect(lib).toContain('if [[ -n "${DX_REWORK_PG_BIN_DIR:-}" ]]');
    expect(lib).toContain('candidate="$(command -v "$tool" || true)"');
    expect(lib).toContain("assert_postgres_toolchain()");
    expect(lib).toContain("show server_version_num");
    expect(lib).toContain("pg_dump major $dump_major is older than database server major $server_major");
    expect(backup).toContain('assert_postgres_toolchain "$DATABASE_URL"');
    expect(backup).toContain("pg_exec pg_dump");
    expect(backup).toContain("pg_exec pg_restore");
    expect(restore).toContain('assert_postgres_toolchain "$DX_REWORK_RESTORE_DATABASE_URL"');
    expect(restore).toContain("pg_exec pg_restore");
    expect(deployExample).toContain("DX_REWORK_PG_BIN_DIR=/usr/pgsql-16/bin");
  });

});
