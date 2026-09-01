const TODO_INDICATOR_POLL_INTERVAL_MS = 60_000;

export const installTodoIndicatorRefresh = (
  refresh: () => void | Promise<void>,
): (() => void) => {
  const run = () => void refresh();
  const handleVisibility = () => {
    if (document.visibilityState === "visible") run();
  };

  run();
  const interval = window.setInterval(run, TODO_INDICATOR_POLL_INTERVAL_MS);
  document.addEventListener("visibilitychange", handleVisibility);
  return () => {
    window.clearInterval(interval);
    document.removeEventListener("visibilitychange", handleVisibility);
  };
};
