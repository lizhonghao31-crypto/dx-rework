import type { InputHTMLAttributes } from "react";
import type { PatternOrderDetail } from "@dx-rework/contracts/pattern-orders";
import { WorkflowRail } from "@dx-rework/ui";
import { patternNodeQuery, patternWorkflow, type PatternStage } from "./pattern-workflow.js";
import "./rework-v2-form.css";
import "./rework-detail.css";
import "./workflow-state-visual.css";

/** Ordinary board-room fields inherit the live rework form, not inset dashboard fields. */
export function PatternField({ label, ...props }: InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  return <div className="rework-v2-grid pattern-single-field"><label><span>{label}</span><input {...props} /></label></div>;
}

export function PatternProgress({ round, misc, selected, search, disabled = false }: { round: PatternOrderDetail["rounds"][number]; misc: boolean; selected: PatternStage; search: string; disabled?: boolean }) {
  const roles = ["板房主管", "板房师傅", misc ? "发起人" : "设计师", "系统"];
  return <nav aria-label="本轮流程"><WorkflowRail className="pattern-flow">{patternWorkflow(round, misc).map((item, index) =>
    <a key={item.stage} href={item.state === "future" || disabled ? undefined : patternNodeQuery(search, item.stage)} className={`is-${item.state}${item.stage === selected ? " is-selected" : ""}`} aria-current={item.stage === selected ? "step" : undefined} aria-disabled={disabled || item.state === "future" || undefined}>
      <b>{item.state === "completed" ? "✓" : index + 1}</b><span><strong>{item.label}</strong><small>{roles[index]}</small></span><em>{item.status}</em>
    </a>
  )}</WorkflowRail></nav>;
}
