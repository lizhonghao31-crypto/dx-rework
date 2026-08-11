export const BUSINESS_TIME_ZONE = "Asia/Shanghai";

const VALUE_LABELS: Readonly<Record<string, string>> = {
  draft: "草稿",
  pending_process_configuration: "待配置工序",
  pending_ie_review: "待 IE 审核",
  pending_task_assignment: "待分工",
  in_progress: "返工执行中",
  pending_order_review: "待整单审核",
  pending_quantity_adjustment_ie_review: "数量调整待 IE 审核",
  pending_responsibility_determination: "待责任判定",
  pending_responsibility_action: "责任处理中",
  completed: "已完成",
  cancelled: "已取消",
  pending_tail_review: "待尾部初核",
  pending_admin_review: "待行政复核",
  ready_to_lock: "待月结",
  locked: "已锁定",
  pending: "待处理",
  approved: "已通过",
  rejected: "已驳回",
  returned: "已退回",
  closed: "已关闭",
  superseded: "已被新版本替代",
  pending_business_signoff: "待业务签收",
  pending_payables_confirmation: "待应付确认",
  deduction_follow_up: "扣款跟进中",
  pending_responsibility_revision: "责任变更中",
  own_factory: "本厂承担",
  processing_factory: "加工厂",
  embroidery_factory: "印绣花厂",
  washing_factory: "洗水厂",
  fabric_supplier: "面料商",
  piece: "件",
  hour: "小时",
  individual: "个人计件",
  collective: "集体计件",
  employee: "正式员工",
  internal: "正式员工",
  temporary: "临时工",
  full: "全额",
  partial: "部分",
  not_deducted: "未扣",
  deduction: "扣款",
  adjustment: "调整",
  reversal: "冲销",
  active: "有效",
  revoked: "已撤销",
  failed: "失败",
  ready: "已就绪",
  rework_overview: "返工总览",
  wages: "工资明细",
  responsibilities: "责任明细",
  own_factory_report: "本厂承担",
  external_deductions: "外部扣款",
  exceptions: "异常明细",
  global: "全局",
  order: "指定订单",
  "image/jpeg": "JPEG 图片",
  "image/png": "PNG 图片",
  "application/pdf": "PDF 文档",
};

const FIELD_LABELS: Readonly<Record<string, string>> = {
  from: "开始时间",
  to: "结束时间",
  actorId: "操作人编号",
  action: "操作动作",
  entityType: "业务对象",
  entityId: "业务对象编号",
  authorizationCapability: "使用权限",
  requestId: "请求编号",
  beforeState: "操作前状态",
  afterState: "操作后状态",
  reason: "操作原因",
  status: "状态",
  sourceEntityType: "来源对象",
  sourceEntityId: "来源对象编号",
  exceptionType: "异常类型",
  safeError: "错误摘要",
  retryable: "是否可重试",
  details: "异常详情",
  amount: "金额",
  proposedAmount: "拟扣金额",
  actualAmount: "累计实扣",
  remainingAmount: "未扣差额",
  exceptionCount: "异常数量",
  reportType: "报表类型",
  exportType: "导出类型",
  createdAt: "创建时间",
  updatedAt: "更新时间",
  expiresAt: "到期时间",
  uploadedAt: "上传时间",
  grantedAt: "授予时间",
  revokedAt: "撤销时间",
  boundEntityId: "绑定业务对象编号",
  boundEntityType: "绑定业务对象",
  scopeType: "授权范围",
  scopeId: "授权范围编号",
  validFrom: "生效时间",
  validUntil: "失效时间",
  roleCode: "业务角色",
  capability: "系统权限",
  personType: "人员类型",
  assignmentMode: "计件模式",
  unit: "计价单位",
  periodStatus: "月结状态",
  wageAmount: "工资金额",
  responsibilityAmount: "责任金额",
  ownFactoryAmount: "本厂承担金额",
  externalProposedAmount: "外部拟扣金额",
  externalDeductedAmount: "累计实扣金额",
  externalRemainingAmount: "未扣差额",
  originalAmount: "原始金额",
  adjustmentAmount: "调整金额",
  finalAmount: "最终金额",
};

const ROLE_LABELS: Readonly<Record<string, string>> = {
  root_superuser: "超级用户",
  owner_group: "老板",
  system_admin: "系统管理员",
  production_management: "生产管理",
  quality_control: "质检",
  tail_supervisor: "尾部主管",
  ie_reviewer: "IE 审核",
  order_merchandiser: "订单跟单",
  embroidery_washing_merchandiser: "印绣花/洗水跟单",
  factory_payables: "加工厂应付会计",
  embroidery_washing_payables: "印绣花洗水应付会计",
  fabric_payables: "面料供应商应付会计",
  administrative_clerk: "行政文员",
  wage_month_close_accountant: "工资月结会计",
  finance_read: "财务全局查看",
  worker: "员工",
  payroll_review: "旧版工资复核（已停用）",
  payroll_close: "旧版工资月结（已停用）",
};

const CAPABILITY_LABELS: Readonly<Record<string, string>> = {
  "admin:read": "查看系统管理",
  "audit:read": "查看审计日志",
  "access:admin": "管理员工权限",
  "master_data:manage": "维护基础资料",
  "report:view": "查看财务报表",
  "report:export": "导出财务报表",
  "wage:view": "查看工资",
  "wage:tail_review": "工资初核",
  "wage:administrative_review": "工资行政复核",
  "wage:month_close": "工资月结",
  "wage:adjustment_request": "发起工资调整",
  "wage:adjustment_approve": "审批工资调整",
  "wage:export": "导出工资",
  "payroll:review": "旧版工资复核权限",
  "payroll:close": "旧版工资月结权限",
  "rework:initiate": "发起返工",
  "responsibility:determine": "责任判定",
  "responsibility:takeover": "接管责任判定",
  "responsibility:confirm_high_multiplier": "确认高倍率责任",
  "work:assign": "返工分工",
  "work:report": "登记本人完成量",
  "work:report_for_worker": "代员工登记完成量",
  "submission:audit": "整单审核",
  "quantity:adjust": "申请数量调整",
  "quantity:confirm": "确认数量调整",
  "process:configure": "配置工序",
  "process:review": "审核工序",
};

const ENTITY_LABELS: Readonly<Record<string, string>> = {
  rework_order: "返工单",
  attachment: "附件",
  external_responsibility_case: "外部责任单",
  responsibility_determination: "责任判定",
  own_factory_approval: "本厂承担审批",
  wage_period: "工资月份",
  wage_adjustment: "工资调整",
  employee_role_assignment: "员工角色授权",
  delegation: "代理授权",
  report_export: "报表导出",
  user_role_assignment: "员工角色授权",
  export_job: "导出任务",
};

const EXCEPTION_LABELS: Readonly<Record<string, string>> = {
  attachment_upload_not_completed: "附件上传未完成",
  overdue_todo: "待办逾期",
  blocked_recipient: "接收人失效",
  todo_delivery_failed: "待办投递失败",
  deduction_follow_up_overdue: "扣款跟进逾期",
};

const ACTION_LABELS: Readonly<Record<string, string>> = {
  "rework.create": "创建返工单",
  "rework.update_draft": "更新返工草稿",
  "rework.submit": "提交返工单",
  "rework.withdraw": "撤回返工单",
  "rework.cancel": "取消返工单",
  "rework.responsibility.draft": "保存责任判定草稿",
  "rework.responsibility.finalize": "完成责任判定",
  "attachment.upload.ready": "附件上传完成",
  "attachment.download.authorized": "附件下载授权",
  "attachment.preview.authorized": "附件预览授权",
  "employee_access.role.grant": "授予员工角色",
  "employee_access.role.revoke": "撤销员工角色",
  "employee_access.disable": "停用员工访问",
  "employee_access.restore": "恢复员工访问",
  "report.exported": "导出业务报表",
  "access.role.assign": "授予业务角色",
  "access.role.revoke": "撤销业务角色",
};

const MONEY_FIELDS = new Set([
  "wageAmount",
  "responsibilityAmount",
  "ownFactoryAmount",
  "externalProposedAmount",
  "externalDeductedAmount",
  "externalRemainingAmount",
  "originalAmount",
  "adjustmentAmount",
  "finalAmount",
  "amount",
  "proposedAmount",
  "actualAmount",
  "remainingAmount",
]);

const unknownFieldLabel = (key: string): string => {
  let checksum = 0;
  for (const character of key) checksum = (checksum * 31 + character.charCodeAt(0)) >>> 0;
  return `未识别业务字段（${checksum.toString(36).toUpperCase()}）`;
};

export const businessFieldLabel = (key: string): string => FIELD_LABELS[key] ?? unknownFieldLabel(key);

export const businessRoleLabel = (value: string): string => ROLE_LABELS[value] ?? "业务角色";

export const businessCapabilityLabel = (value: string): string =>
  CAPABILITY_LABELS[value] ?? "系统授权";

export const businessEntityLabel = (value: string): string =>
  ENTITY_LABELS[value] ?? "业务对象";

export const businessExceptionLabel = (value: string): string =>
  EXCEPTION_LABELS[value] ?? "系统异常";

export const businessActionLabel = (value: string): string =>
  ACTION_LABELS[value] ?? (value.startsWith("rework.") ? "返工业务操作" : "系统操作");

export const formatBusinessTime = (value: string | Date | null | undefined): string => {
  if (!value) return "—";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("zh-CN", {
    timeZone: BUSINESS_TIME_ZONE,
    hour12: false,
  });
};

export const formatFileSize = (value: number | string): string => {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return "大小未知";
  if (bytes < 1024) return `${bytes} 字节`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

export const businessCellValue = (
  key: string,
  value: string | number | boolean | null | undefined,
): string => {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "boolean") return value ? "是" : "否";
  const text = String(value);
  if (/(?:At|Time|From|Until)$/.test(key) && !/^\d{4}-\d{2}$/.test(text)) {
    return formatBusinessTime(text);
  }
  if (key === "action") return businessActionLabel(text);
  if (/(?:^|)entityType$/i.test(key) || key === "sourceEntityType" || key === "boundEntityType") {
    return businessEntityLabel(text);
  }
  if (key === "authorizationCapability" || key === "capability") {
    return businessCapabilityLabel(text);
  }
  if (key === "roleCode") return businessRoleLabel(text);
  return VALUE_LABELS[text] ?? text;
};

export const businessValue = (
  key: string,
  value: string | number | boolean | null | undefined,
): string => {
  if (value === null || value === undefined || value === "") return "—";
  const text = businessCellValue(key, value);
  return MONEY_FIELDS.has(key) ? `¥${text}` : text;
};

export const formatBusinessDecimal = (
  value: string | number,
  maximumFractionDigits = 3,
): string => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return String(value);
  return numeric.toLocaleString("zh-CN", {
    minimumFractionDigits: 0,
    maximumFractionDigits,
  });
};

export const translateTechnicalDetails = (value: unknown, key = ""): unknown => {
  if (Array.isArray(value)) return value.map((item) => translateTechnicalDetails(item, key));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [
      businessFieldLabel(entryKey),
      translateTechnicalDetails(entryValue, entryKey),
    ]));
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) {
    if (key === "action") return businessActionLabel(String(value));
    if (key === "entityType" || key === "sourceEntityType") return businessEntityLabel(String(value));
    if (key === "authorizationCapability" || key === "capability") return businessCapabilityLabel(String(value));
    if (key === "exceptionType") return businessExceptionLabel(String(value));
    return businessValue(key, value);
  }
  return value;
};
