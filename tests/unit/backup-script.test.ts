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
});
