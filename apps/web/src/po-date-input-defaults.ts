export function changePoDate<T, K extends keyof T>(rows: readonly T[], column: K, index: number,
  date: T[K], overrides: ReadonlySet<number>, synchronize = true): T[] {
  return rows.map((row, position) => position === index
    || synchronize && index === 0 && position > 0 && !overrides.has(position)
    ? { ...row, [column]: date } : row);
}

export function inheritPoDate<T, K extends keyof T>(row: T, first: T | undefined, column: K): T {
  return first?.[column] === undefined ? row : { ...row, [column]: first[column] };
}

export function removePoDateOverride(overrides: ReadonlySet<number>, index: number): Set<number> {
  return new Set([...overrides].filter(position => position !== index).map(position => position > index ? position - 1 : position));
}
