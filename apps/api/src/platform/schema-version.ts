import migrationManifest from "./migration-manifest.json" with { type: "json" };

const expectedMigration = migrationManifest.migrations.at(-1);
if (!expectedMigration) throw new Error("Migration manifest must not be empty");

export const EXPECTED_SCHEMA_VERSION = expectedMigration.version;
export const EXPECTED_SCHEMA_CHECKSUM = expectedMigration.checksum;
