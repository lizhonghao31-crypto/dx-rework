import { Readable } from "node:stream";
import { createInflate } from "node:zlib";

const MAX_PNG_DECODED_BYTES = 128 * 1024 * 1024;

export class InvalidStoredFileError extends Error {
  constructor() {
    super("Stored file content is invalid");
    this.name = "InvalidStoredFileError";
  }
}

const invalid = (): never => {
  throw new InvalidStoredFileError();
};

const ascii = (bytes: Buffer, offset: number, length: number): string =>
  bytes.toString("ascii", offset, offset + length);

const uint32be = (bytes: Buffer, offset: number): number =>
  bytes.readUInt32BE(offset);

const uint32le = (bytes: Buffer, offset: number): number =>
  bytes.readUInt32LE(offset);

const crcTable = Uint32Array.from({ length: 256 }, (_value, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return crc >>> 0;
});

const crc32 = (bytes: Buffer, start: number, end: number): number => {
  let crc = 0xffffffff;
  for (let index = start; index < end; index += 1) {
    crc = crcTable[(crc ^ bytes[index]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
};

const jpegFrameMarkers = new Set([
  0xc0, 0xc1, 0xc2, 0xc3,
  0xc5, 0xc6, 0xc7,
  0xc9, 0xca, 0xcb,
  0xcd, 0xce, 0xcf,
]);

const validateJpeg = (bytes: Buffer): void => {
  if (bytes.length < 12
    || bytes[0] !== 0xff
    || bytes[1] !== 0xd8
    || bytes.at(-2) !== 0xff
    || bytes.at(-1) !== 0xd9) invalid();

  let offset = 2;
  let hasFrame = false;
  let hasScan = false;
  while (offset < bytes.length - 2) {
    if (bytes[offset] !== 0xff) invalid();
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset] ?? invalid();
    offset += 1;
    if (marker === 0x00 || marker === 0xd8 || marker === 0xd9) invalid();
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length - 2) invalid();
    const segmentLength = bytes.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length - 2) invalid();

    if (jpegFrameMarkers.has(marker)) {
      if (segmentLength < 8
        || bytes.readUInt16BE(offset + 3) === 0
        || bytes.readUInt16BE(offset + 5) === 0) invalid();
      hasFrame = true;
    }
    if (marker === 0xda) {
      if (segmentLength < 6) invalid();
      hasScan = true;
      break;
    }
    offset += segmentLength;
  }
  if (!hasFrame || !hasScan) invalid();
};

const pngChannels = new Map<number, number>([
  [0, 1],
  [2, 3],
  [3, 1],
  [4, 2],
  [6, 4],
]);

const validPngBitDepths = new Map<number, readonly number[]>([
  [0, [1, 2, 4, 8, 16]],
  [2, [8, 16]],
  [3, [1, 2, 4, 8]],
  [4, [8, 16]],
  [6, [8, 16]],
]);

const adam7Passes = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
] as const;

const passLength = (value: number, start: number, step: number): number =>
  value <= start ? 0 : Math.ceil((value - start) / step);

const expectedPngInflatedBytes = (
  width: number,
  height: number,
  bitsPerPixel: number,
  interlace: number,
): number => {
  const scanBytes = (scanWidth: number, scanHeight: number): number =>
    scanWidth === 0 || scanHeight === 0
      ? 0
      : scanHeight * (1 + Math.ceil(scanWidth * bitsPerPixel / 8));
  if (interlace === 0) return scanBytes(width, height);
  return adam7Passes.reduce((total, [x, y, dx, dy]) => total + scanBytes(
    passLength(width, x, dx),
    passLength(height, y, dy),
  ), 0);
};

const validatePngInflate = async (chunks: readonly Buffer[], expectedBytes: number): Promise<void> => {
  const inflater = createInflate();
  const source = Readable.from(chunks);
  source.pipe(inflater);
  let inflatedBytes = 0;
  try {
    for await (const chunk of inflater) {
      inflatedBytes += (chunk as Buffer).byteLength;
      if (inflatedBytes > expectedBytes) invalid();
    }
  } catch (error) {
    if (error instanceof InvalidStoredFileError) throw error;
    invalid();
  } finally {
    source.destroy();
    inflater.destroy();
  }
  if (inflatedBytes !== expectedBytes) invalid();
};

const validatePng = async (bytes: Buffer): Promise<void> => {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (bytes.length < 45 || !bytes.subarray(0, 8).equals(signature)) invalid();

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitsPerPixel = 0;
  let interlace = 0;
  let hasHeader = false;
  let hasPalette = false;
  let hasData = false;
  let hasEnd = false;
  const compressed: Buffer[] = [];

  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) invalid();
    const dataLength = uint32be(bytes, offset);
    const typeStart = offset + 4;
    const dataStart = offset + 8;
    const dataEnd = dataStart + dataLength;
    const chunkEnd = dataEnd + 4;
    if (dataEnd < dataStart || chunkEnd > bytes.length) invalid();
    const type = ascii(bytes, typeStart, 4);
    if (!/^[A-Za-z]{4}$/.test(type)
      || crc32(bytes, typeStart, dataEnd) !== uint32be(bytes, dataEnd)) invalid();

    if (!hasHeader && type !== "IHDR") invalid();
    if (type === "IHDR") {
      if (hasHeader || dataLength !== 13) invalid();
      width = uint32be(bytes, dataStart);
      height = uint32be(bytes, dataStart + 4);
      const bitDepth = bytes[dataStart + 8]!;
      const colorType = bytes[dataStart + 9]!;
      const channels = pngChannels.get(colorType) ?? invalid();
      interlace = bytes[dataStart + 12]!;
      if (width === 0 || height === 0
        || !validPngBitDepths.get(colorType)?.includes(bitDepth)
        || bytes[dataStart + 10] !== 0
        || bytes[dataStart + 11] !== 0
        || (interlace !== 0 && interlace !== 1)) invalid();
      bitsPerPixel = channels * bitDepth;
      hasHeader = true;
    } else if (type === "PLTE") {
      if (hasData || dataLength === 0 || dataLength % 3 !== 0 || dataLength > 768) invalid();
      hasPalette = true;
    } else if (type === "IDAT") {
      if (!hasHeader || dataLength === 0) invalid();
      hasData = true;
      compressed.push(bytes.subarray(dataStart, dataEnd));
    } else if (type === "IEND") {
      if (dataLength !== 0 || !hasData || chunkEnd !== bytes.length) invalid();
      hasEnd = true;
      offset = chunkEnd;
      break;
    }
    offset = chunkEnd;
  }

  if (!hasHeader || !hasData || !hasEnd || (bytes[25] === 3 && !hasPalette)) invalid();
  const expectedBytes = expectedPngInflatedBytes(width, height, bitsPerPixel, interlace);
  if (!Number.isSafeInteger(expectedBytes)
    || expectedBytes <= 0
    || expectedBytes > MAX_PNG_DECODED_BYTES) invalid();
  await validatePngInflate(compressed, expectedBytes);
};

const validateWebp = (bytes: Buffer): void => {
  if (bytes.length < 26
    || ascii(bytes, 0, 4) !== "RIFF"
    || ascii(bytes, 8, 4) !== "WEBP"
    || uint32le(bytes, 4) + 8 !== bytes.length) invalid();

  let offset = 12;
  let imageChunks = 0;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) invalid();
    const type = ascii(bytes, offset, 4);
    const dataLength = uint32le(bytes, offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + dataLength;
    const paddedEnd = dataEnd + (dataLength % 2);
    if (dataEnd < dataStart || paddedEnd > bytes.length) invalid();

    if (type === "VP8 ") {
      if (dataLength < 10
        || (bytes[dataStart]! & 1) !== 0
        || bytes[dataStart + 3] !== 0x9d
        || bytes[dataStart + 4] !== 0x01
        || bytes[dataStart + 5] !== 0x2a
        || (bytes.readUInt16LE(dataStart + 6) & 0x3fff) === 0
        || (bytes.readUInt16LE(dataStart + 8) & 0x3fff) === 0) invalid();
      imageChunks += 1;
    } else if (type === "VP8L") {
      if (dataLength < 5 || bytes[dataStart] !== 0x2f) invalid();
      const dimensions = uint32le(bytes, dataStart + 1);
      if ((dimensions >>> 29) !== 0) invalid();
      imageChunks += 1;
    } else if (type === "VP8X") {
      if (dataLength !== 10
        || (bytes[dataStart]! & 0xc1) !== 0
        || bytes[dataStart + 1] !== 0
        || bytes[dataStart + 2] !== 0
        || bytes[dataStart + 3] !== 0) invalid();
    }
    offset = paddedEnd;
  }
  if (offset !== bytes.length || imageChunks !== 1) invalid();
};

const validatePdf = (bytes: Buffer): void => {
  if (bytes.length < 14 || !/^%PDF-\d\.\d/.test(ascii(bytes, 0, 8))) invalid();
  const tail = bytes.toString("latin1", Math.max(0, bytes.length - 1024));
  const eof = tail.lastIndexOf("%%EOF");
  const allowedTrailingCharacters = new Set(["\0", "\t", "\n", "\f", "\r", " "]);
  if (eof < 0 || [...tail.slice(eof + 5)].some(
    (character) => !allowedTrailingCharacters.has(character),
  )) invalid();
};

export const validateStoredFileContent = async (
  content: Uint8Array,
  mimeType: string,
): Promise<void> => {
  const bytes = Buffer.from(content.buffer, content.byteOffset, content.byteLength);
  switch (mimeType.toLowerCase()) {
    case "image/jpeg":
      validateJpeg(bytes);
      return;
    case "image/png":
      await validatePng(bytes);
      return;
    case "image/webp":
      validateWebp(bytes);
      return;
    case "application/pdf":
      validatePdf(bytes);
      return;
    default:
      invalid();
  }
};
