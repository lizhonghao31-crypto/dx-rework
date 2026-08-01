import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("PostgreSQL backup manifest", () => {
  it("stores a relative dump filename so checksum verification survives relocation", async () => {
    const script = await readFile(new URL("../../scripts/backup-postgres.sh", import.meta.url), "utf8");
    expect(script).toContain('cd "${DX_REWORK_BACKUP_DIR}"');
    expect(script).toContain('sha256sum "${filename}" > "${filename}.sha256"');
    expect(script).not.toContain('sha256sum "${target}"');
  });
});
