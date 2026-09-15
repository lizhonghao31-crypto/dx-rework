import type { InputHTMLAttributes } from "react";
import type { PatternOrderDetail } from "@dx-rework/contracts/pattern-orders";
import { elapsedText } from "./pattern-order-client.js";
import { patternNodeQuery, patternWorkflow, type PatternStage } from "./pattern-workflow.js";
import "./rework-v2-form.css";
import "./rework-detail.css";
import "./workflow-state-visual.css";

/** Ordinary board-room fields inherit the live rework form, not inset dashboard fields. */
export function PatternField({ label, ...props }: InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  return <div className="rework-v2-grid pattern-single-field"><label><span>{label}</span><input {...props} /></label></div>;
}

export function PatternProgress({ round, misc, selected, search, disabled = false }: { round: PatternOrderDetail["rounds"][number]; misc: boolean; selected: PatternStage; search: string; disabled?: boolean }) {
  return <nav className="rework-detail-target-layout" aria-label="本轮流程"><div className="pattern-progress">{patternWorkflow(round, misc).map(item =>
    <a key={item.stage} href={patternNodeQuery(search, item.stage)} className={`rework-workflow__node is-${item.state}${item.stage === selected ? " is-selected" : ""}`} aria-current={item.stage === selected ? "step" : undefined} aria-disabled={disabled || undefined} onClick={event => { if (disabled) event.preventDefault(); }}>
      <b>{item.number}</b><span><strong>{item.label}</strong><small>{item.status}{item.node ? ` · ${elapsedText(item.node.elapsedSeconds)}` : ""}</small></span>
    </a>
  )}</div></nav>;
}
