import type { AuthorizedUser } from "./auth.js";
import { accessiblePlatformModules } from "./platform-modules.js";

export type AcceptanceModuleId = "rework" | "sourcing" | "suppliers" | "production" | "samples";
export type AcceptanceMatrixVerdict = "pass" | "fail" | "pending";
export type AcceptanceRuleStatus = "approved" | "pending" | "unmapped" | "infrastructure";

export type AcceptanceRuleRef = Readonly<{
  ruleId: string;
  status: AcceptanceRuleStatus;
}>;

export type AcceptanceHttpProbe = Readonly<{
  id: string;
  label: string;
  path: string;
  expectedStatus: number;
  infrastructure?: boolean;
}>;

export type AcceptanceRoleExpectation = Readonly<{
  alias: string;
  expectedRole: string;
  expectedRoot?: boolean;
  requiredCapabilities?: readonly string[];
  forbiddenCapabilities?: readonly string[];
  allowedModules?: readonly AcceptanceModuleId[];
  forbiddenModules?: readonly AcceptanceModuleId[];
  probes?: readonly AcceptanceHttpProbe[];
  ruleRefs?: Readonly<Record<string, AcceptanceRuleRef>>;
}>;

export type AcceptanceIdentitySnapshot = Readonly<{
  alias: string;
  userId: string;
  roleCodes: readonly string[];
  capabilities: readonly string[];
}>;

export type AcceptanceMatrixCheck = Readonly<{
  key: string;
  category: "identity" | "session" | "capability" | "module" | "http";
  label: string;
  expected: string;
  actual: string;
  verdict: AcceptanceMatrixVerdict;
  ruleId: string;
  ruleStatus: AcceptanceRuleStatus;
}>;

export const ACCEPTANCE_INFRASTRUCTURE_RULE: AcceptanceRuleRef = Object.freeze({
  ruleId: "ACCEPTANCE-INFRASTRUCTURE",
  status: "infrastructure",
});

const UNMAPPED_BUSINESS_RULE: AcceptanceRuleRef = Object.freeze({
  ruleId: "PERM-ACCEPTANCE-UNMAPPED-001",
  status: "unmapped",
});
const approved = (ruleId: string): AcceptanceRuleRef => ({ ruleId, status: "approved" });

const probe = (id: string, label: string, path: string, expectedStatus: number): AcceptanceHttpProbe => ({
  id,
  label,
  path,
  expectedStatus,
});

const accessRolesAllow = probe("access-roles", "人员权限角色表", "access/roles", 200);
const accessRolesDeny = probe("access-roles", "人员权限角色表", "access/roles", 403);
const reworkReportAllow = probe("rework-report-list", "返工管理列表", "management/rework-orders", 200);
const sourcingAllow = probe("sourcing-list", "报价选厂订单列表", "sourcing/cases?page=1", 200);
const sourcingDeny = probe("sourcing-list", "报价选厂订单列表", "sourcing/cases?page=1", 403);
const suppliersAllow = probe("supplier-list", "供应商目录", "master-data/suppliers", 200);
const suppliersDeny = probe("supplier-list", "供应商目录", "master-data/suppliers", 403);
const productionDashboardAllow = probe("production-dashboard", "实时生产看板", "production-dashboard", 200);
const productionDashboardDeny = probe("production-dashboard", "实时生产看板", "production-dashboard", 403);
const samplesAllow = probe("sample-list", "样衣目录", "samples?page=1", 200);
const samplesDeny = probe("sample-list", "样衣目录", "samples?page=1", 403);

const sampleMutationCapabilities = [
  "sample:create",
  "sample:batch_create",
  "sample:borrow_request",
  "sample:borrow_confirm",
  "sample:return_request",
  "sample:return_confirm",
  "sample:update_basic",
  "sample:update_location",
  "sample:correct_finance",
  "sample:dispose_request",
  "sample:dispose_approve",
  "sample:loss_close",
  "sample:archive",
] as const;

const sampleMutationDenyRules = Object.fromEntries(
  sampleMutationCapabilities.map((capability) => [
    `cap:${capability}:deny`,
    approved("PERM-SAMPLE-FINANCE-DIRECTOR-001"),
  ]),
);

/**
 * Business expectations remain independent from runtime RBAC, but only checks
 * traceable to an APPROVED Golden Source rule may pass/fail. PENDING or unmapped
 * business checks are still executed and retain expected/actual evidence, while
 * their verdict is "pending" so current implementation cannot become the oracle.
 */
export const ACCEPTANCE_ROLE_MATRIX: readonly AcceptanceRoleExpectation[] = [
  {
    alias: "root",
    expectedRole: "owner_group",
    expectedRoot: true,
    allowedModules: ["rework", "sourcing", "suppliers", "production", "samples"],
    probes: [accessRolesAllow, sourcingAllow, suppliersAllow, productionDashboardAllow, samplesAllow],
    ruleRefs: {
      "module:rework:allow": approved("PERM-PLATFORM-ROOT-001"),
      "module:sourcing:allow": approved("PERM-PLATFORM-ROOT-001"),
      "module:suppliers:allow": approved("PERM-PLATFORM-ROOT-001"),
      "module:production:allow": approved("PERM-PLATFORM-ROOT-001"),
      "module:samples:allow": approved("PERM-PLATFORM-ROOT-001"),
      "http:access-roles": approved("PERM-PLATFORM-ROOT-001"),
      "http:sourcing-list": approved("PERM-PLATFORM-ROOT-001"),
      "http:supplier-list": approved("PERM-PLATFORM-ROOT-001"),
      "http:production-dashboard": approved("PERM-PLATFORM-ROOT-001"),
      "http:sample-list": approved("PERM-PLATFORM-ROOT-001"),
    },
  },
  {
    alias: "owner",
    expectedRole: "owner_group",
    requiredCapabilities: ["todo:view", "sourcing:view", "supplier_profile:read", "sample:view_basic"],
    forbiddenCapabilities: ["access:admin"],
    allowedModules: ["rework", "sourcing", "suppliers", "production", "samples"],
    probes: [accessRolesDeny, sourcingAllow, suppliersAllow, productionDashboardAllow, samplesAllow],
    ruleRefs: {
      "cap:todo:view:allow": approved("PERM-PLATFORM-OWNER-001"),
      "cap:sourcing:view:allow": approved("PERM-PLATFORM-OWNER-001"),
      "cap:supplier_profile:read:allow": approved("PERM-SUPPLIER-OWNER-001"),
      "cap:sample:view_basic:allow": approved("PERM-PLATFORM-OWNER-001"),
      "cap:access:admin:deny": approved("PERM-PLATFORM-ACCESS-ADMIN-001"),
      "module:rework:allow": approved("PERM-PLATFORM-OWNER-001"),
      "module:sourcing:allow": approved("PERM-PLATFORM-OWNER-001"),
      "module:suppliers:allow": approved("PERM-SUPPLIER-OWNER-001"),
      "module:production:allow": approved("PERM-PLATFORM-OWNER-001"),
      "module:samples:allow": approved("PERM-PLATFORM-OWNER-001"),
      "http:access-roles": approved("PERM-PLATFORM-ACCESS-ADMIN-001"),
      "http:sourcing-list": approved("PERM-PLATFORM-OWNER-001"),
      "http:supplier-list": approved("PERM-SUPPLIER-OWNER-001"),
      "http:production-dashboard": approved("PERM-PLATFORM-OWNER-001"),
      "http:sample-list": approved("PERM-PLATFORM-OWNER-001"),
    },
  },
  {
    alias: "production-management",
    expectedRole: "production_management",
    requiredCapabilities: ["sourcing:view"],
    forbiddenCapabilities: ["sample:view_basic", "access:admin"],
    allowedModules: ["rework", "sourcing", "suppliers", "production"],
    forbiddenModules: ["samples"],
    probes: [accessRolesDeny, sourcingAllow, suppliersAllow, productionDashboardAllow, samplesDeny],
    ruleRefs: {
      "cap:sourcing:view:allow": approved("PERM-SOURCING-FIVE-001"),
      "module:sourcing:allow": approved("PERM-SOURCING-FIVE-001"),
      "http:sourcing-list": approved("PERM-SOURCING-FIVE-001"),
      "module:suppliers:allow": approved("PERM-SUPPLIER-PM-CENTER-001"),
      "http:supplier-list": approved("PERM-SUPPLIER-PM-CENTER-001"),
      "module:production:allow": approved("PERM-ROLE-PRODUCTION-MANAGEMENT-001"),
      "http:production-dashboard": approved("PERM-ROLE-PRODUCTION-MANAGEMENT-001"),
    },
  },
  {
    alias: "ie",
    expectedRole: "ie_reviewer",
    requiredCapabilities: ["process:review", "sourcing:view"],
    forbiddenCapabilities: ["sample:view_basic", "access:admin"],
    allowedModules: ["rework", "sourcing", "suppliers"],
    forbiddenModules: ["samples", "production"],
    probes: [accessRolesDeny, sourcingAllow, suppliersAllow, productionDashboardDeny, samplesDeny],
    ruleRefs: {
      "cap:sourcing:view:allow": approved("PERM-SOURCING-FIVE-001"),
      "module:sourcing:allow": approved("PERM-SOURCING-FIVE-001"),
      "http:sourcing-list": approved("PERM-SOURCING-FIVE-001"),
      "module:suppliers:allow": approved("PERM-SUPPLIER-IE-CENTER-001"),
      "http:supplier-list": approved("PERM-SUPPLIER-IE-CENTER-001"),
      "module:production:deny": approved("PERM-ROLE-IE-001"),
      "http:production-dashboard": approved("PERM-ROLE-IE-001"),
    },
  },
  {
    alias: "tail-supervisor",
    expectedRole: "tail_supervisor",
    requiredCapabilities: ["process:configure", "work:assign", "supplier_profile:read"],
    forbiddenCapabilities: ["sourcing:view", "sample:view_basic", "access:admin"],
    allowedModules: ["rework", "suppliers"],
    forbiddenModules: ["sourcing", "production", "samples"],
    probes: [accessRolesDeny, sourcingDeny, suppliersAllow, productionDashboardDeny, samplesDeny],
    ruleRefs: {
      "cap:supplier_profile:read:allow": approved("PERM-SUPPLIER-TAIL-001"),
      "module:suppliers:allow": approved("PERM-SUPPLIER-TAIL-001"),
      "http:supplier-list": approved("PERM-SUPPLIER-TAIL-001"),
    },
  },
  {
    alias: "qc",
    expectedRole: "quality_control",
    requiredCapabilities: ["rework:initiate", "supplier_profile:read"],
    forbiddenCapabilities: ["sourcing:view", "sample:view_basic", "access:admin"],
    allowedModules: ["rework", "suppliers"],
    forbiddenModules: ["sourcing", "production", "samples"],
    probes: [accessRolesDeny, sourcingDeny, suppliersAllow, productionDashboardDeny, samplesDeny],
    ruleRefs: {
      "cap:supplier_profile:read:allow": approved("PERM-SUPPLIER-QC-001"),
      "module:suppliers:allow": approved("PERM-SUPPLIER-QC-001"),
      "http:supplier-list": approved("PERM-SUPPLIER-QC-001"),
    },
  },
  {
    alias: "warehouse",
    expectedRole: "warehouse_receiver",
    requiredCapabilities: ["receiving:create"],
    forbiddenCapabilities: ["sourcing:view", "sample:view_basic", "access:admin"],
    allowedModules: ["rework"],
    forbiddenModules: ["sourcing", "suppliers", "production", "samples"],
    probes: [accessRolesDeny, sourcingDeny, suppliersDeny, productionDashboardDeny, samplesDeny],
    ruleRefs: {
      "module:suppliers:deny": approved("PERM-SUPPLIER-WAREHOUSE-001"),
      "http:supplier-list": approved("PERM-SUPPLIER-WAREHOUSE-001"),
    },
  },
  {
    alias: "worker-a",
    expectedRole: "worker",
    requiredCapabilities: ["work:report"],
    forbiddenCapabilities: ["access:admin", "sourcing:view", "supplier_profile:read", "sample:view_basic"],
    allowedModules: ["rework"],
    forbiddenModules: ["sourcing", "suppliers", "production", "samples"],
    probes: [accessRolesDeny, sourcingDeny, suppliersDeny, productionDashboardDeny, samplesDeny],
    ruleRefs: {
      "cap:work:report:allow": approved("PERM-REWORK-WORKER-001"),
      "module:rework:allow": approved("PERM-REWORK-WORKER-001"),
      "cap:supplier_profile:read:deny": approved("PERM-SUPPLIER-WORKER-001"),
      "module:suppliers:deny": approved("PERM-SUPPLIER-WORKER-001"),
      "http:supplier-list": approved("PERM-SUPPLIER-WORKER-001"),
      "cap:access:admin:deny": approved("PERM-PLATFORM-WORKER-CROSSMODULE-001"),
      "cap:sourcing:view:deny": approved("PERM-PLATFORM-WORKER-CROSSMODULE-001"),
      "cap:sample:view_basic:deny": approved("PERM-PLATFORM-WORKER-CROSSMODULE-001"),
      "module:sourcing:deny": approved("PERM-PLATFORM-WORKER-CROSSMODULE-001"),
      "module:production:deny": approved("PERM-PLATFORM-WORKER-CROSSMODULE-001"),
      "module:samples:deny": approved("PERM-PLATFORM-WORKER-CROSSMODULE-001"),
      "http:access-roles": approved("PERM-PLATFORM-WORKER-CROSSMODULE-001"),
      "http:sourcing-list": approved("PERM-PLATFORM-WORKER-CROSSMODULE-001"),
      "http:production-dashboard": approved("PERM-PLATFORM-WORKER-CROSSMODULE-001"),
      "http:sample-list": approved("PERM-PLATFORM-WORKER-CROSSMODULE-001"),
    },
  },
  {
    alias: "worker-b",
    expectedRole: "worker",
    requiredCapabilities: ["work:report"],
    forbiddenCapabilities: ["access:admin", "sourcing:view", "supplier_profile:read", "sample:view_basic"],
    allowedModules: ["rework"],
    forbiddenModules: ["sourcing", "suppliers", "production", "samples"],
    probes: [accessRolesDeny, sourcingDeny, suppliersDeny, productionDashboardDeny, samplesDeny],
    ruleRefs: {
      "cap:work:report:allow": approved("PERM-REWORK-WORKER-001"),
      "module:rework:allow": approved("PERM-REWORK-WORKER-001"),
      "cap:supplier_profile:read:deny": approved("PERM-SUPPLIER-WORKER-001"),
      "module:suppliers:deny": approved("PERM-SUPPLIER-WORKER-001"),
      "http:supplier-list": approved("PERM-SUPPLIER-WORKER-001"),
      "cap:access:admin:deny": approved("PERM-PLATFORM-WORKER-CROSSMODULE-001"),
      "cap:sourcing:view:deny": approved("PERM-PLATFORM-WORKER-CROSSMODULE-001"),
      "cap:sample:view_basic:deny": approved("PERM-PLATFORM-WORKER-CROSSMODULE-001"),
      "module:sourcing:deny": approved("PERM-PLATFORM-WORKER-CROSSMODULE-001"),
      "module:production:deny": approved("PERM-PLATFORM-WORKER-CROSSMODULE-001"),
      "module:samples:deny": approved("PERM-PLATFORM-WORKER-CROSSMODULE-001"),
      "http:access-roles": approved("PERM-PLATFORM-WORKER-CROSSMODULE-001"),
      "http:sourcing-list": approved("PERM-PLATFORM-WORKER-CROSSMODULE-001"),
      "http:production-dashboard": approved("PERM-PLATFORM-WORKER-CROSSMODULE-001"),
      "http:sample-list": approved("PERM-PLATFORM-WORKER-CROSSMODULE-001"),
    },
  },
  {
    alias: "merchandiser",
    expectedRole: "order_merchandiser",
    requiredCapabilities: ["sourcing:view", "sourcing:inquiry:create", "supplier_profile:read"],
    forbiddenCapabilities: ["sample:view_basic", "access:admin"],
    allowedModules: ["rework", "sourcing", "suppliers", "production"],
    forbiddenModules: ["samples"],
    probes: [accessRolesDeny, sourcingAllow, suppliersAllow, productionDashboardAllow, samplesDeny],
    ruleRefs: {
      "cap:sourcing:view:allow": approved("PERM-SOURCING-FIVE-001"),
      "cap:sourcing:inquiry:create:allow": approved("PERM-SOURCING-FIVE-001"),
      "module:sourcing:allow": approved("PERM-SOURCING-FIVE-001"),
      "http:sourcing-list": approved("PERM-SOURCING-FIVE-001"),
      "cap:supplier_profile:read:allow": approved("PERM-SUPPLIER-MERCH-CENTER-001"),
      "module:suppliers:allow": approved("PERM-SUPPLIER-MERCH-CENTER-001"),
      "http:supplier-list": approved("PERM-SUPPLIER-MERCH-CENTER-001"),
      "module:production:allow": approved("PERM-ROLE-MERCHANDISER-001"),
      "http:production-dashboard": approved("PERM-ROLE-MERCHANDISER-001"),
    },
  },
  {
    alias: "finance-read",
    expectedRole: "finance_read",
    requiredCapabilities: ["report:view"],
    forbiddenCapabilities: ["sourcing:view", "supplier_profile:read", "sample:view_basic", "access:admin"],
    allowedModules: ["rework"],
    forbiddenModules: ["sourcing", "suppliers", "production", "samples"],
    probes: [accessRolesDeny, reworkReportAllow, sourcingDeny, suppliersDeny, productionDashboardDeny, samplesDeny],
    ruleRefs: {
      "cap:report:view:allow": approved("PERM-REWORK-FINANCE-READ-001"),
      "module:rework:allow": approved("PERM-REWORK-FINANCE-READ-001"),
      "http:rework-report-list": approved("PERM-REWORK-FINANCE-READ-001"),
    },
  },
  {
    alias: "finance-director",
    expectedRole: "finance_director",
    requiredCapabilities: ["sourcing:view", "supplier_profile:read", "sample:view_basic", "sample:view_finance", "sample:view_audit"],
    forbiddenCapabilities: ["access:admin", ...sampleMutationCapabilities],
    allowedModules: ["rework", "sourcing", "suppliers", "production", "samples"],
    probes: [accessRolesDeny, sourcingAllow, suppliersAllow, productionDashboardAllow, samplesAllow],
    ruleRefs: {
      "cap:sourcing:view:allow": approved("PERM-SOURCING-FIVE-001"),
      "module:sourcing:allow": approved("PERM-SOURCING-FIVE-001"),
      "http:sourcing-list": approved("PERM-SOURCING-FIVE-001"),
      "cap:supplier_profile:read:allow": approved("PERM-SUPPLIER-FINANCE-CENTER-001"),
      "module:suppliers:allow": approved("PERM-SUPPLIER-FINANCE-CENTER-001"),
      "http:supplier-list": approved("PERM-SUPPLIER-FINANCE-CENTER-001"),
      "module:production:allow": approved("PERM-ROLE-FINANCE-DIRECTOR-001"),
      "http:production-dashboard": approved("PERM-ROLE-FINANCE-DIRECTOR-001"),
      "cap:sample:view_basic:allow": approved("PERM-SAMPLE-FINANCE-DIRECTOR-001"),
      "cap:sample:view_finance:allow": approved("PERM-SAMPLE-FINANCE-DIRECTOR-001"),
      "cap:sample:view_audit:allow": approved("PERM-SAMPLE-FINANCE-DIRECTOR-001"),
      ...sampleMutationDenyRules,
      "module:samples:allow": approved("PERM-SAMPLE-FINANCE-DIRECTOR-001"),
      "http:sample-list": approved("PERM-SAMPLE-FINANCE-DIRECTOR-001"),
      "module:rework:allow": approved("PERM-REWORK-FINANCE-DIRECTOR-001"),
      "cap:access:admin:deny": approved("PERM-PLATFORM-ACCESS-ADMIN-001"),
      "http:access-roles": approved("PERM-PLATFORM-ACCESS-ADMIN-001"),
    },
  },
  {
    alias: "factory-payables",
    expectedRole: "factory_payables",
    requiredCapabilities: ["sourcing:view", "supplier_profile:read"],
    forbiddenCapabilities: ["sample:view_basic", "access:admin"],
    allowedModules: ["sourcing", "suppliers"],
    forbiddenModules: ["samples", "production"],
    probes: [accessRolesDeny, sourcingAllow, suppliersAllow, productionDashboardDeny, samplesDeny],
    ruleRefs: {
      "cap:supplier_profile:read:allow": approved("PERM-SUPPLIER-FACTORY-PAYABLES-CENTER-001"),
      "module:suppliers:allow": approved("PERM-SUPPLIER-FACTORY-PAYABLES-CENTER-001"),
      "http:supplier-list": approved("PERM-SUPPLIER-FACTORY-PAYABLES-CENTER-001"),
    },
  },
  {
    alias: "system-admin",
    expectedRole: "system_admin",
    requiredCapabilities: ["admin:read", "audit:read"],
    forbiddenCapabilities: ["access:admin", "sample:view_basic", "sourcing:view"],
    forbiddenModules: ["sourcing", "suppliers", "production", "samples"],
    probes: [accessRolesDeny, sourcingDeny, suppliersDeny, productionDashboardDeny, samplesDeny],
    ruleRefs: {
      "cap:admin:read:allow": approved("PERM-PLATFORM-SYSADMIN-001"),
      "cap:audit:read:allow": approved("PERM-PLATFORM-SYSADMIN-001"),
      "cap:access:admin:deny": approved("PERM-PLATFORM-SYSADMIN-001"),
      "cap:sample:view_basic:deny": approved("PERM-PLATFORM-SYSADMIN-001"),
      "cap:sourcing:view:deny": approved("PERM-PLATFORM-SYSADMIN-001"),
      "module:sourcing:deny": approved("PERM-PLATFORM-SYSADMIN-001"),
      "module:suppliers:deny": approved("PERM-PLATFORM-SYSADMIN-001"),
      "module:production:deny": approved("PERM-PLATFORM-SYSADMIN-001"),
      "module:samples:deny": approved("PERM-PLATFORM-SYSADMIN-001"),
      "http:access-roles": approved("PERM-PLATFORM-SYSADMIN-001"),
      "http:sourcing-list": approved("PERM-PLATFORM-SYSADMIN-001"),
      "http:supplier-list": approved("PERM-PLATFORM-SYSADMIN-001"),
      "http:production-dashboard": approved("PERM-PLATFORM-SYSADMIN-001"),
      "http:sample-list": approved("PERM-PLATFORM-SYSADMIN-001"),
    },
  },
  {
    alias: "production-reporter",
    expectedRole: "production_reporter",
    requiredCapabilities: ["production-reporting"],
    forbiddenCapabilities: ["sample:view_basic", "access:admin"],
    allowedModules: ["production"],
    forbiddenModules: ["sourcing", "suppliers", "samples"],
    probes: [accessRolesDeny, sourcingDeny, suppliersDeny, productionDashboardAllow, samplesDeny],
    ruleRefs: {
      "cap:production-reporting:allow": approved("PERM-PRODUCTION-REPORTER-001"),
      "module:production:allow": approved("PERM-PRODUCTION-REPORTER-001"),
      "http:production-dashboard": approved("PERM-PRODUCTION-REPORTER-001"),
    },
  },
  {
    alias: "sample-designer",
    expectedRole: "sample_designer",
    requiredCapabilities: ["sample:view_basic"],
    forbiddenCapabilities: ["sample:view_finance", "sourcing:view", "access:admin"],
    allowedModules: ["samples"],
    forbiddenModules: ["sourcing", "suppliers", "production"],
    probes: [accessRolesDeny, sourcingDeny, suppliersDeny, productionDashboardDeny, samplesAllow],
    ruleRefs: {
      "cap:sample:view_basic:allow": approved("PERM-SAMPLE-DESIGNER-001"),
      "cap:sample:view_finance:deny": approved("PERM-SAMPLE-DESIGNER-001"),
      "module:samples:allow": approved("PERM-SAMPLE-DESIGNER-001"),
      "http:sample-list": approved("PERM-SAMPLE-DESIGNER-001"),
    },
  },
  {
    alias: "sample-admin",
    expectedRole: "sample_administrative",
    requiredCapabilities: ["sample:view_basic"],
    forbiddenCapabilities: ["sample:view_finance", "sourcing:view", "access:admin"],
    allowedModules: ["samples"],
    forbiddenModules: ["sourcing", "suppliers", "production"],
    probes: [accessRolesDeny, sourcingDeny, suppliersDeny, productionDashboardDeny, samplesAllow],
    ruleRefs: {
      "cap:sample:view_basic:allow": approved("PERM-SAMPLE-ADMIN-001"),
      "cap:sample:view_finance:deny": approved("PERM-SAMPLE-ADMIN-001"),
      "module:samples:allow": approved("PERM-SAMPLE-ADMIN-001"),
      "http:sample-list": approved("PERM-SAMPLE-ADMIN-001"),
    },
  },
  {
    alias: "sample-finance",
    expectedRole: "sample_finance",
    requiredCapabilities: ["sample:view_basic", "sample:view_finance"],
    forbiddenCapabilities: ["sourcing:view", "access:admin"],
    allowedModules: ["samples"],
    forbiddenModules: ["sourcing", "suppliers", "production"],
    probes: [accessRolesDeny, sourcingDeny, suppliersDeny, productionDashboardDeny, samplesAllow],
    ruleRefs: {
      "cap:sample:view_basic:allow": approved("PERM-SAMPLE-FINANCE-001"),
      "cap:sample:view_finance:allow": approved("PERM-SAMPLE-FINANCE-001"),
      "module:samples:allow": approved("PERM-SAMPLE-FINANCE-001"),
      "http:sample-list": approved("PERM-SAMPLE-FINANCE-001"),
    },
  },
];

const ruleFor = (expectation: AcceptanceRoleExpectation, key: string): AcceptanceRuleRef =>
  expectation.ruleRefs?.[key] ?? UNMAPPED_BUSINESS_RULE;

const check = (
  key: string,
  category: AcceptanceMatrixCheck["category"],
  label: string,
  expected: string,
  actual: string,
  passed: boolean,
  rule: AcceptanceRuleRef,
): AcceptanceMatrixCheck => ({
  key,
  category,
  label,
  expected,
  actual,
  verdict: rule.status === "pending" || rule.status === "unmapped"
    ? "pending"
    : passed ? "pass" : "fail",
  ruleId: rule.ruleId,
  ruleStatus: rule.status,
});

export function expectationForAlias(alias: string): AcceptanceRoleExpectation | undefined {
  return ACCEPTANCE_ROLE_MATRIX.find((entry) => entry.alias === alias);
}

export function evaluateAcceptanceSnapshot(
  expectation: AcceptanceRoleExpectation,
  identity: AcceptanceIdentitySnapshot,
  user: AuthorizedUser,
): AcceptanceMatrixCheck[] {
  const checks: AcceptanceMatrixCheck[] = [];
  const identityRoles = [...identity.roleCodes].sort();
  const sessionRoles = [...(user.businessRoles ?? [])].sort();
  checks.push(check(
    `${expectation.alias}:identity-role`,
    "identity",
    "数据库身份角色",
    expectation.expectedRole,
    identityRoles.join(", ") || "无",
    identityRoles.length === 1 && identityRoles[0] === expectation.expectedRole,
    ACCEPTANCE_INFRASTRUCTURE_RULE,
  ));
  checks.push(check(
    `${expectation.alias}:session-user`,
    "session",
    "业务 Session 用户",
    identity.userId,
    user.id,
    user.id === identity.userId,
    ACCEPTANCE_INFRASTRUCTURE_RULE,
  ));
  checks.push(check(
    `${expectation.alias}:session-role`,
    "session",
    "业务 Session 角色",
    expectation.expectedRole,
    sessionRoles.join(", ") || "无",
    sessionRoles.length === 1 && sessionRoles[0] === expectation.expectedRole,
    ACCEPTANCE_INFRASTRUCTURE_RULE,
  ));
  const rootExpected = expectation.expectedRoot === true;
  checks.push(check(
    `${expectation.alias}:root`,
    "session",
    "Root 身份",
    rootExpected ? "是" : "否",
    user.isRoot ? "是" : "否",
    user.isRoot === rootExpected,
    ACCEPTANCE_INFRASTRUCTURE_RULE,
  ));

  for (const capability of expectation.requiredCapabilities ?? []) {
    const localKey = `cap:${capability}:allow`;
    checks.push(check(
      `${expectation.alias}:${localKey}`,
      "capability",
      `应有 ${capability}`,
      "允许",
      user.capabilities.includes(capability) ? "允许" : "缺失",
      user.capabilities.includes(capability),
      ruleFor(expectation, localKey),
    ));
  }
  for (const capability of expectation.forbiddenCapabilities ?? []) {
    const localKey = `cap:${capability}:deny`;
    checks.push(check(
      `${expectation.alias}:${localKey}`,
      "capability",
      `不得有 ${capability}`,
      "拒绝",
      user.capabilities.includes(capability) ? "意外允许" : "拒绝",
      !user.capabilities.includes(capability),
      ruleFor(expectation, localKey),
    ));
  }

  const actualModules = new Set(accessiblePlatformModules(user).map((module) => module.id));
  for (const moduleId of expectation.allowedModules ?? []) {
    const localKey = `module:${moduleId}:allow`;
    checks.push(check(
      `${expectation.alias}:${localKey}`,
      "module",
      `模块 ${moduleId}`,
      "可进入",
      actualModules.has(moduleId) ? "可进入" : "不可进入",
      actualModules.has(moduleId),
      ruleFor(expectation, localKey),
    ));
  }
  for (const moduleId of expectation.forbiddenModules ?? []) {
    const localKey = `module:${moduleId}:deny`;
    checks.push(check(
      `${expectation.alias}:${localKey}`,
      "module",
      `模块 ${moduleId}`,
      "不可进入",
      actualModules.has(moduleId) ? "意外可进入" : "不可进入",
      !actualModules.has(moduleId),
      ruleFor(expectation, localKey),
    ));
  }
  return checks;
}

export function evaluateHttpProbe(
  expectationOrAlias: AcceptanceRoleExpectation | string,
  probeDefinition: AcceptanceHttpProbe,
  actualStatus: number,
): AcceptanceMatrixCheck {
  const alias = typeof expectationOrAlias === "string" ? expectationOrAlias : expectationOrAlias.alias;
  const rule = probeDefinition.infrastructure
    ? ACCEPTANCE_INFRASTRUCTURE_RULE
    : typeof expectationOrAlias === "string"
      ? UNMAPPED_BUSINESS_RULE
      : ruleFor(expectationOrAlias, `http:${probeDefinition.id}`);
  return check(
    `${alias}:http:${probeDefinition.id}`,
    "http",
    probeDefinition.label,
    `HTTP ${probeDefinition.expectedStatus}`,
    `HTTP ${actualStatus}`,
    actualStatus === probeDefinition.expectedStatus,
    rule,
  );
}
