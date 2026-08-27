import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { createClientRequestId } from "../../apps/web/src/client-request-id.js";
import { describe, expect, it } from "vitest";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const sourceFiles = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:ts|tsx)$/.test(entry.name) ? [path] : [];
  }));
  return nested.flat();
};

describe("client request id compatibility", () => {
  it("uses native randomUUID with the provider as its receiver", () => {
    const expected = "00000000-0000-4000-8000-000000000001";
    const provider = {
      randomUUID(this: unknown) {
        expect(this).toBe(provider);
        return expected;
      },
    };
    expect(createClientRequestId(provider)).toBe(expected);
  });

  it("builds a valid UUID when randomUUID is unavailable", () => {
    const provider = {
      getRandomValues(values: Uint8Array) {
        values.forEach((_, index) => { values[index] = index; });
        return values;
      },
    };
    expect(createClientRequestId(provider)).toMatch(UUID_V4);
  });

  it("falls back when an embedded browser exposes a broken randomUUID method", () => {
    const provider = {
      randomUUID() {
        throw new TypeError("randomUUID is unavailable");
      },
      getRandomValues(values: Uint8Array) {
        values.fill(7);
        return values;
      },
    };
    expect(createClientRequestId(provider)).toMatch(UUID_V4);
  });

  it("still returns distinct valid IDs when Web Crypto is unavailable", () => {
    const first = createClientRequestId(null);
    const second = createClientRequestId(null);
    expect(first).toMatch(UUID_V4);
    expect(second).toMatch(UUID_V4);
    expect(second).not.toBe(first);
  });

  it("keeps direct randomUUID calls out of browser source", async () => {
    const root = fileURLToPath(new URL("../../apps/web/src/", import.meta.url));
    const files = await sourceFiles(root);
    const directCalls = [];
    for (const file of files) {
      const content = await readFile(file, "utf8");
      if (/\bcrypto\.randomUUID\s*\(/.test(content)) directCalls.push(file);
    }
    expect(directCalls).toEqual([]);
  });
});
