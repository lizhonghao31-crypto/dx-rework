export const mapWithConcurrency = async <T, Result>(
  items: readonly T[],
  limit: number,
  operation: (item: T, index: number) => Promise<Result>,
): Promise<Result[]> => {
  if (items.length === 0) return [];
  const results = new Array<Result>(items.length);
  const workerCount = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  let nextIndex = 0;
  let stopped = false;

  const worker = async (): Promise<void> => {
    while (!stopped) {
      const index = nextIndex;
      if (index >= items.length) return;
      nextIndex += 1;
      try {
        results[index] = await operation(items[index]!, index);
      } catch (error) {
        stopped = true;
        throw error;
      }
    }
  };

  const outcomes = await Promise.allSettled(Array.from({ length: workerCount }, worker));
  const failure = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
  if (failure) throw failure.reason;
  return results;
};
