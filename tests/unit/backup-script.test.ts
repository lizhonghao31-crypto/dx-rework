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

    expect(lib).toContain("database_connection_identity()");
    expect(lib).toContain('select current_database()');
    expect(lib).not.toContain("inet_server_addr()");
    expect(lib).not.toContain("inet_server_port()");
    expect(backup).toContain('database_connection_fingerprint "$DATABASE_URL"');
    expect(restore).toContain('database_connection_identity "$DX_REWORK_RESTORE_DATABASE_URL"');
    expect(backup).not.toContain("inet_server_addr()");
    expect(restore).not.toContain("inet_server_addr()");
  });
});
