import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

type Manifest = Readonly<{
  migrations: ReadonlyArray<Readonly<{
    version: string;
    checksum: string;
  }>>;
}>;

describe("current migration manifest checksums", () => {
  it("matches every versioned SQL file byte-for-byte", async () => {
    const manifest = JSON.parse(await readFile(
      "apps/api/src/platform/migration-manifest.json",
      "utf8",
    )) as Manifest;

    expect(manifest.migrations.length).toBeGreaterThan(0);
    for (const migration of manifest.migrations) {
      const sql = await readFile(
        `apps/api/migrations/${migration.version}.sql`,
        "utf8",
      );
      const checksum = createHash("sha256").update(sql).digest("hex");
      expect(checksum, migration.version).toBe(migration.checksum);
    }
  });
});
