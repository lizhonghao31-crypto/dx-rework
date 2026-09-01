import type { TodoNewIndicator } from "@dx-rework/contracts";

export type TodoArrivalMarker = Readonly<{
  todoId: string;
  receivedAt: string;
}>;

const seenStorageKey = (userId: string): string => `dx-rework.todo-seen.${userId}`;

const compareMarkers = (left: TodoArrivalMarker, right: TodoArrivalMarker): number =>
  left.receivedAt.localeCompare(right.receivedAt) || left.todoId.localeCompare(right.todoId);

export const indicatorMarker = (indicator: TodoNewIndicator): TodoArrivalMarker | null =>
  indicator.latestTodoId && indicator.latestReceivedAt
    ? { todoId: indicator.latestTodoId, receivedAt: indicator.latestReceivedAt }
    : null;

export const readSeenTodoMarker = (
  storage: Pick<Storage, "getItem"> | null,
  userId: string,
): TodoArrivalMarker | null => {
  if (!storage) return null;
  try {
    const value = storage.getItem(seenStorageKey(userId));
    if (!value) return null;
    const parsed = JSON.parse(value) as Partial<TodoArrivalMarker>;
    return typeof parsed.todoId === "string" && typeof parsed.receivedAt === "string"
      ? { todoId: parsed.todoId, receivedAt: parsed.receivedAt }
      : null;
  } catch {
    return null;
  }
};

export const writeSeenTodoMarker = (
  storage: Pick<Storage, "setItem" | "getItem"> | null,
  userId: string,
  marker: TodoArrivalMarker,
): void => {
  if (!storage) return;
  try {
    const seen = readSeenTodoMarker(storage, userId);
    if (!seen || compareMarkers(marker, seen) > 0) {
      storage.setItem(seenStorageKey(userId), JSON.stringify(marker));
    }
  } catch {
    // Private browsing or storage policy may make local persistence unavailable.
  }
};

export const isUnseenTodoMarker = (
  marker: TodoArrivalMarker,
  seen: TodoArrivalMarker | null,
): boolean => !seen || compareMarkers(marker, seen) > 0;
