export const XLSX_RESOURCE_BUDGET = Object.freeze({ compressedBytes: 2 * 1024 * 1024, entries: 128, entryBytes: 8 * 1024 * 1024, totalBytes: 16 * 1024 * 1024, ratio: 200 });
const reject = (): never => { throw new Error("文件解压资源超限或 ZIP 结构无效，请使用标准供应商模板"); };
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let crc = index; for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  return crc >>> 0;
});

/** Checks metadata AND actual streamed output before read-excel-file can inflate the archive. */
export async function validateXlsxResourceBudget(bytes: Uint8Array): Promise<void> {
  const limits = XLSX_RESOURCE_BUDGET;
  if (bytes.length > limits.compressedBytes || bytes.length < 22) reject();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (offset: number) => offset >= 0 && offset + 2 <= bytes.length ? view.getUint16(offset, true) : reject();
  const u32 = (offset: number) => offset >= 0 && offset + 4 <= bytes.length ? view.getUint32(offset, true) : reject();
  let end = bytes.length - 22;
  while (end >= Math.max(0, bytes.length - 65_557) && (u32(end) !== 0x06054b50 || end + 22 + u16(end + 20) !== bytes.length)) end -= 1;
  if (end < 0 || u32(end) !== 0x06054b50 || u16(end + 4) !== 0 || u16(end + 6) !== 0) reject();
  const count = u16(end + 10); const centralSize = u32(end + 12); const centralStart = u32(end + 16);
  if (!count || count > limits.entries || u16(end + 8) !== count || centralStart + centralSize !== end) reject();
  const entries: { start: number; size: number; expected: number; method: number; crc: number }[] = [];
  const names = new Set<string>(); const ranges: [number, number][] = [];
  let cursor = centralStart; let declaredTotal = 0;
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > end || u32(cursor) !== 0x02014b50) reject();
    const flags = u16(cursor + 8); const method = u16(cursor + 10); const crc = u32(cursor + 16);
    const size = u32(cursor + 20); const expected = u32(cursor + 24);
    const nameLength = u16(cursor + 28); const extraLength = u16(cursor + 30); const commentLength = u16(cursor + 32); const local = u32(cursor + 42);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (next > end || !nameLength || u16(cursor + 34) !== 0 || (flags & ~0x080e) !== 0 || ![0, 8].includes(method)) reject();
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    const name = Array.from(nameBytes).join(",");
    if (names.has(name)) reject(); names.add(name);
    if (expected > limits.entryBytes || (size === 0 && expected !== 0) || expected > Math.max(1, size) * limits.ratio) reject();
    declaredTotal += expected; if (declaredTotal > limits.totalBytes) reject();
    if (local + 30 > centralStart || u32(local) !== 0x04034b50 || u16(local + 6) !== flags || u16(local + 8) !== method || u16(local + 26) !== nameLength) reject();
    const start = local + 30 + nameLength + u16(local + 28);
    if (start + size > centralStart || !nameBytes.every((value, offset) => bytes[local + 30 + offset] === value)) reject();
    if (!(flags & 8) && (u32(local + 14) !== crc || u32(local + 18) !== size || u32(local + 22) !== expected)) reject();
    ranges.push([local, start + size]); entries.push({ start, size, expected, method, crc }); cursor = next;
  }
  if (cursor !== end) reject();
  ranges.sort((a, b) => a[0] - b[0]);
  if (ranges.some((range, index) => index > 0 && range[0] < ranges[index - 1]![1])) reject();
  let total = 0;
  for (const entry of entries) {
    const compressed = bytes.slice(entry.start, entry.start + entry.size);
    let stream: ReadableStream<Uint8Array> = new Blob([compressed]).stream();
    if (entry.method === 8) {
      try { stream = stream.pipeThrough(new DecompressionStream("deflate-raw")); } catch { reject(); }
    }
    const reader = stream.getReader(); let actual = 0; let crc = 0xffffffff;
    try {
      while (true) {
        const result = await reader.read(); if (result.done) break;
        actual += result.value.byteLength; total += result.value.byteLength;
        if (actual > entry.expected || actual > limits.entryBytes || total > limits.totalBytes) reject();
        for (const byte of result.value) crc = crcTable[(crc ^ byte) & 255]! ^ (crc >>> 8);
      }
      if (actual !== entry.expected || ((crc ^ 0xffffffff) >>> 0) !== entry.crc) reject();
    } catch { reject(); } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  }
}
