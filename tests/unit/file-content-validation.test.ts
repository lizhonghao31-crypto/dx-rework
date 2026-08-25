import { describe, expect, it } from "vitest";

import {
  InvalidStoredFileError,
  validateStoredFileContent,
} from "../../apps/api/src/tools/file-content-validation.js";

const jpeg = Buffer.from([
  0xff, 0xd8,
  0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x01, 0x00, 0x01, 0x03,
  0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
  0xff, 0xda, 0x00, 0x0c, 0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3f, 0x00,
  0x00,
  0xff, 0xd9,
]);

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

const webp = Buffer.from(
  "UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoBAAEAAUAmJaACdLoB+AADsAD+8ut//NgVzXPv9//S4P0uD9Lg/9KQAAA=",
  "base64",
);

describe("stored file content validation", () => {
  it.each([
    ["JPEG", jpeg, "image/jpeg"],
    ["PNG", png, "image/png"],
    ["WebP", webp, "image/webp"],
    ["PDF", Buffer.from("%PDF-1.4\n%%EOF\n"), "application/pdf"],
  ])("accepts structurally valid %s bytes", async (_name, content, mimeType) => {
    await expect(validateStoredFileContent(content, mimeType)).resolves.toBeUndefined();
  });

  it.each([
    ["image/jpeg"],
    ["image/png"],
    ["image/webp"],
    ["application/pdf"],
  ])("rejects a text payload declared as %s", async (mimeType) => {
    await expect(validateStoredFileContent(
      Buffer.from("not the declared file type"),
      mimeType,
    )).rejects.toBeInstanceOf(InvalidStoredFileError);
  });

  it("rejects a PNG whose body no longer matches its chunk CRC", async () => {
    const corrupted = Buffer.from(png);
    corrupted[corrupted.length - 16] ^= 0xff;
    await expect(validateStoredFileContent(corrupted, "image/png"))
      .rejects.toBeInstanceOf(InvalidStoredFileError);
  });

  it("rejects content appended after a JPEG end marker", async () => {
    await expect(validateStoredFileContent(
      Buffer.concat([jpeg, Buffer.from("extra")]),
      "image/jpeg",
    )).rejects.toBeInstanceOf(InvalidStoredFileError);
  });
});
