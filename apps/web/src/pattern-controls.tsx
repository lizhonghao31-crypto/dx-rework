import type { InputHTMLAttributes } from "react";
import type { PatternOrderDetail } from "@dx-rework/contracts/pattern-orders";
import { elapsedText } from "./pattern-order-client.js";
import "./rework-v2-form.css";
import "./rework-detail.css";
import "./workflow-state-visual.css";

/** Ordinary board-room fields inherit the live rework form, not inset dashboard fields. */
export function PatternField({ label, ...props }: InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  return <div className="rework-v2-grid pattern-single-field"><label><span>{label}</span><input {...props} /></label></div>;
}

export function PatternProgress({ round, misc }: { round: PatternOrderDetail["rounds"][number]; misc: boolean }) {
  const stages = ["pending_assignment", "in_progress", "pending_confirmation", "completed"] as const;
  const labels = ["分配师傅", "制作中", misc ? "确认完成" : "确认交接", "已完成"];
  return <div className="rework-detail-target-layout"><ol className="pattern-progress" aria-label="本轮流程">{stages.map((stage, index) => {
    const node = round.nodes.find(item => item.stage === stage);
    const state = round.status === "cancelled" ? node ? "completed" : "future"
      : stage === "completed" ? round.status === "completed" ? "completed" : "future"
      : node?.exitedAt ? "completed" : node ? "current" : "future";
    return <li key={stage} className={`rework-workflow__node is-${state}`} aria-current={state === "current" ? "step" : undefined}><b>{String(index + 1).padStart(2, "0")}</b><span><strong>{labels[index]}</strong><small>{node ? elapsedText(node.elapsedSeconds) : stage === "completed" && round.status === "completed" ? "已完成" : round.status === "cancelled" ? "已取消" : "未开始"}</small></span></li>;
  })}</ol></div>;
}
