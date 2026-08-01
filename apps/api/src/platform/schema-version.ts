import migrationManifest from "./migration-manifest.json" with { type: "json" };

const expectedMigration = migrationManifest.migrations.at(-1);
if (!expectedMigration) throw new Error("Migration manifest must not be empty");

export type MigrationFingerprint = Readonly<{ version: string; checksum: string }>;
export const EXPECTED_SCHEMA_HISTORY: readonly MigrationFingerprint[] = migrationManifest.migrations;
export const EXPECTED_SCHEMA_VERSION = expectedMigration.version;
export const EXPECTED_SCHEMA_CHECKSUM = expectedMigration.checksum;

export function migrationHistoriesMatch(
  applied: readonly MigrationFingerprint[],
  expected: readonly MigrationFingerprint[] = EXPECTED_SCHEMA_HISTORY,
): boolean {
  return (
    applied.length === expected.length &&
    applied.every(
      (migration, index) =>
        migration.version === expected[index]?.version && migration.checksum === expected[index]?.checksum,
    )
  );
}
