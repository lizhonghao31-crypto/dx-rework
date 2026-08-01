import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { findPotentialSecrets } from "../../scripts/secret-scan.mjs";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function createFixtureDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "dx-rework-secret-scan-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("secret scan", () => {
  it("scans secret-bearing extensions instead of relying on an allowlist", async () => {
    const directory = await createFixtureDirectory();
    await writeFile(join(directory, "credential.pem"), ["-----BEGIN ", "PRIVATE KEY-----"].join(""));
    await writeFile(join(directory, ".env"), ["TOKEN=gh", "p_", "a".repeat(30)].join(""));
    await writeFile(join(directory, "notes.txt"), ["AK", "IA", "A".repeat(16)].join(""));

    await expect(findPotentialSecrets(directory, new Set())).resolves.toEqual([
      ".env",
      "credential.pem",
      "notes.txt",
    ]);
  });

  it("skips binary files", async () => {
    const directory = await createFixtureDirectory();
    await writeFile(join(directory, "asset.bin"), Buffer.from([0, 1, 2, 3, 65, 75, 73, 65]));
    await expect(findPotentialSecrets(directory, new Set())).resolves.toEqual([]);
  });
});
