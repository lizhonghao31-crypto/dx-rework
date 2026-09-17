/** Compare style identifiers without changing their recorded spelling or punctuation. */
export const normalizeSourcingStyleNumber = (value: string): string =>
  value.trim().replace(/[A-Z]/g, letter => letter.toLowerCase());

export type SourcingStyleIdentity = Readonly<{
  position?: number;
  styleNo?: string | null | undefined;
  alternateStyleNo?: string | null | undefined;
  color?: string | null | undefined;
}>;

export const sourcingStyleNumbers = (lines: readonly SourcingStyleIdentity[]): string[] =>
  [...new Set(lines.flatMap(line => [line.styleNo, line.alternateStyleNo])
    .filter((value): value is string => !!value?.trim()).map(normalizeSourcingStyleNumber))].sort();

export function duplicateSourcingLineMessage(lines: readonly SourcingStyleIdentity[]): string | null {
  const seen = new Map<string, number>();
  for (const [index, line] of lines.entries()) {
    const position = line.position ?? index + 1;
    const color = normalizeSourcingStyleNumber(line.color ?? "");
    for (const style of sourcingStyleNumbers([line])) {
      const key = JSON.stringify([style, color]);
      const previous = seen.get(key);
      if (previous !== undefined) return `第 ${previous} 行与第 ${position} 行款号（含代用款号）及颜色重复，请核对后修正`;
      seen.set(key, position);
    }
  }
  return null;
}
