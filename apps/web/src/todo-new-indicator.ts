export const formatTodoBadgeCount = (count: number): string =>
  count > 99 ? "99+" : String(count);
