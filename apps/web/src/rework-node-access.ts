import type { WorkflowNodeKey } from "./rework-detail-page.js";

// Shared with the existing N05 workspace: quantity adjustments also use N05.
export const WHOLE_ORDER_REVIEW_CAPABILITIES = [
  "submission:audit", "quantity:adjust", "quantity:confirm", "process:review",
] as const;

export function canOperateReworkNode(capabilities: readonly string[], node: WorkflowNodeKey): boolean {
  const required: Partial<Record<WorkflowNodeKey, readonly string[]>> = {
    initiation: ["rework:initiate"], process_configuration: ["process:configure"], ie_review: ["process:review"],
    task_assignment: ["work:assign"], work_reporting: ["work:report", "work:report_for_worker", "tail_inspection:report", "submission:audit"],
    whole_order_review: WHOLE_ORDER_REVIEW_CAPABILITIES, final_quantity_ie_review: ["process:review"],
    quantity_adjustment: ["quantity:adjust", "quantity:confirm", "process:review"],
    responsibility: ["responsibility:determine", "responsibility:takeover", "responsibility:confirm_high_multiplier"],
    owner_signature: ["responsibility:owner_sign"],
  };
  return (required[node] ?? []).some(capability => capabilities.includes(capability));
}
