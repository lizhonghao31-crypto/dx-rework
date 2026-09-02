export function todoPageWindow(
  currentPage: number,
  totalPages: number,
  windowSize = 5,
): readonly number[] {
  const pageCount = Math.max(1, Math.floor(totalPages));
  const size = Math.max(1, Math.min(Math.floor(windowSize), pageCount));
  const current = Math.min(pageCount, Math.max(1, Math.floor(currentPage)));
  const half = Math.floor(size / 2);
  const start = pageCount <= size
    ? 1
    : current <= half + 1
      ? 1
      : current >= pageCount - half
        ? pageCount - size + 1
        : current - half;
  return Array.from({ length: size }, (_, index) => start + index);
}
