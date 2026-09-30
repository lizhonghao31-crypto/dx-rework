import type { PatternOrderDetail } from "@dx-rework/contracts/pattern-orders";

export type PatternRound = PatternOrderDetail["rounds"][number];
export type PatternStage = PatternRound["status"];

export function patternWorkflow(round: PatternRound, misc: boolean) {
  const stopped = Boolean(round.stoppedAt || round.nodes.some(node => node.exitReason === "rework" || node.exitReason === "cancelled"));
  const stages: PatternStage[] = ["pending_assignment", "in_progress", "pending_confirmation", round.status === "cancelled" ? "cancelled" : "completed"];
  const labels = ["分配师傅", "制作中", misc ? "确认完成" : "确认交接", round.status === "cancelled" ? "已取消" : "已完成"];
  return stages.map((stage, index) => {
    const node = round.nodes.find(item => item.stage === stage);
    const terminal = stage === "cancelled" || stage === "completed";
    const interrupted = Boolean(node?.exitedAt && (node.exitReason === "cancelled" || node.exitReason === "rework"));
    const state = terminal ? round.status === stage ? stage === "cancelled" ? "cancelled" : "completed" : "future"
      : interrupted ? "stopped" : node?.exitedAt ? "completed" : node ? "current" : "future";
    const status = interrupted ? node?.exitReason === "cancelled" ? "已终止" : "已转入返工"
      : stage === "cancelled" ? "已取消" : state === "completed" ? "已完成" : state === "current" ? "当前节点"
      : round.status === "cancelled" || stopped ? "未执行" : "未开始";
    return { stage, label: labels[index]!, number: String(index + 1).padStart(2, "0"), state, status, node };
  });
}

export function patternSelectedStage(round: PatternRound, search: string): PatternStage {
  const requested = new URLSearchParams(search).get("node");
  return patternWorkflow(round, false).find(item => item.stage === requested)?.stage ?? round.status;
}

export function patternNodeQuery(search: string, stage: PatternStage): string {
  const params = new URLSearchParams(search);
  params.set("node", stage);
  return `?${params}#pattern-node-workspace`;
}
