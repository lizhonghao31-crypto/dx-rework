import type { DigitalTask } from "@dx-rework/contracts/digital-production-tasks";

export type DigitalTaskView = "read" | "handle" | "correct";
export function digitalTaskView(search: string): DigitalTaskView {
  const view = new URLSearchParams(search).get("taskView");
  return view === "read" || view === "correct" ? view : "handle";
}
export function canWriteDigitalTask(view: DigitalTaskView, task: DigitalTask | null, path: string): boolean {
  if (view === "read") return false;
  if (view === "correct") return Boolean(task?.canCorrect && path === `tasks/${task.taskId}/time-corrections`);
  return true;
}
