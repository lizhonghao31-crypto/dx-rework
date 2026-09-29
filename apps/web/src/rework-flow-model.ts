export const reworkFlowNodes: Record<string, { label: string; role: string }> = {
  draft: { label: "N01 · 发起返工", role: "跟单 / 发起人" },
  pending_process_configuration: { label: "N02 · 配置工序", role: "尾部主管" },
  pending_ie_review: { label: "N03 · IE 审核", role: "IE" },
  pending_task_assignment: { label: "N02-R · 启动任务", role: "尾部主管" },
  in_progress: { label: "N04 · 返工执行", role: "返工人员 / 授权代录人" },
  pending_order_review: { label: "N05 · 最终数量确认", role: "尾部主管" },
  pending_final_quantity_ie_review: { label: "N06 · IE 复核", role: "IE" },
  pending_quantity_adjustment_ie_review: { label: "N06-A · 数量调整复核", role: "跟单 / IE" },
  pending_responsibility_determination: { label: "N07 · 责任判定", role: "供应链总监 / 责任办理人" },
  pending_owner_signature: { label: "N08 · 老板确认", role: "老板" },
  pending_responsibility_action: { label: "旧责任处理", role: "原责任办理角色" },
  completed: { label: "已完成", role: "—" },
};
