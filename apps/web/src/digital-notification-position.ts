export type NotificationBox = Readonly<{ left: number; right: number; top: number; bottom: number }>;

// Only lift a desktop notification when it overlaps a visible business action.
// Work from the default corner position, so repeated measurements never drift.
export function notificationActionLift(base: NotificationBox, actions: readonly NotificationBox[]): number {
  let lift = 0;
  for (const action of [...actions].sort((a, b) => b.top - a.top)) {
    if (base.left >= action.right || base.right <= action.left) continue;
    if (base.top - lift >= action.bottom || base.bottom - lift <= action.top) continue;
    lift = Math.min(Math.max(0, base.top - 72), base.bottom - action.top + 8);
  }
  return Math.max(0, lift);
}
