import type { AuthorizedUser } from "./auth.js";
import { accessiblePlatformModules } from "./platform-modules.js";

export type AcceptanceModuleId = "rework" | "sourcing" | "suppliers" | "production" | "samples";
export type AcceptanceMatrixVerdict = "pass" | "fail";

export type AcceptanceHttpProbe = Readonly<{
  id: string;
  label: string;
  path: string;
  expectedStatus: number;
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
}>;

export type AcceptanceIdentitySnapshot = Readonly<{
  alias: string;
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
}>;

const probe = (id: string, label: string, path: string, expectedStatus: number): AcceptanceHttpProbe => ({
  id,
  label,
  path,
  expectedStatus,
});

const accessRolesAllow = probe("access-roles", "人员权限角色表", "access/roles", 200);
const accessRolesDeny = probe("access-roles", "人员权限角色表", "access/roles", 403);
const sourcingAllow = probe("sourcing-list", "报价选厂订单列表", "sourcing/cases?page=1", 200);
const sourcingDeny = probe("sourcing-list", "报价选厂订单列表", "sourcing/cases?page=1", 403);
const suppliersAllow = probe("supplier-list", "供应商目录", "master-data/suppliers", 200);
const suppliersDeny = probe("supplier-list", "供应商目录", "master-data/suppliers", 403);
const samplesAllow = probe("sample-list", "样衣目录", "samples?page=1", 200);
const samplesDeny = probe("sample-list", "样衣目录", "samples?page=1", 403);

/**
 * Approved expectations are deliberately declared here instead of being generated
 * from role_capabilities. Runtime RBAC is the measured result, never the oracle.
 *
 * The finance-director sample expectation records the 2026-09-08 approved target
 * (read access). It is expected to surface a mismatch until the later permission
 * remediation PR fixes the real role policy.
 */
export const ACCEPTANCE_ROLE_MATRIX: readonly AcceptanceRoleExpectation[] = [
  {
    alias: "root",
    expectedRole: "owner_group",
    expectedRoot: true,
    allowedModules: ["rework", "sourcing", "suppliers", "production", "samples"],
    probes: [accessRolesAllow, sourcingAllow, suppliersAllow, samplesAllow],
  },
  {
    alias: "owner",
    expectedRole: "owner_group",
    requiredCapabilities: ["todo:view", "sourcing:view", "supplier_profile:read", "sample:view_basic"],
    allowedModules: ["rework", "sourcing", "suppliers", "production", "samples"],
    probes: [accessRolesAllow, sourcingAllow, suppliersAllow, samplesAllow],
  },
  {
    alias: "production-management",
    expectedRole: "production_management",
    requiredCapabilities: ["sourcing:view"],
    forbiddenCapabilities: ["sample:view_basic", "access:admin"],
    allowedModules: ["rework", "sourcing", "suppliers", "production"],
    forbiddenModules: ["samples"],
    probes: [accessRolesDeny, sourcingAllow, suppliersAllow, samplesDeny],
  },
  {
    alias: "ie",
    expectedRole: "ie_reviewer",
    requiredCapabilities: ["process:review", "sourcing:view"],
    forbiddenCapabilities: ["sample:view_basic", "access:admin"],
    allowedModules: ["rework", "sourcing", "suppliers"],
    forbiddenModules: ["samples", "production"],
    probes: [accessRolesDeny, sourcingAllow, suppliersAllow, samplesDeny],
  },
  {
    alias: "tail-supervisor",
    expectedRole: "tail_supervisor",
    requiredCapabilities: ["process:configure", "work:assign"],
    forbiddenCapabilities: ["sourcing:view", "sample:view_basic", "access:admin"],
    allowedModules: ["rework"],
    forbiddenModules: ["sourcing", "suppliers", "production", "samples"],
    probes: [accessRolesDeny, sourcingDeny, suppliersDeny, samplesDeny],
  },
  {
    alias: "qc",
    expectedRole: "quality_control",
    requiredCapabilities: ["rework:initiate"],
    forbiddenCapabilities: ["sourcing:view", "sample:view_basic", "access:admin"],
    allowedModules: ["rework"],
    forbiddenModules: ["sourcing", "suppliers", "production", "samples"],
    probes: [accessRolesDeny, sourcingDeny, suppliersDeny, samplesDeny],
  },
  {
    alias: "warehouse",
    expectedRole: "warehouse_receiver",
    requiredCapabilities: ["receiving:create"],
    forbiddenCapabilities: ["sourcing:view", "sample:view_basic", "access:admin"],
    allowedModules: ["rework"],
    forbiddenModules: ["sourcing", "suppliers", "production", "samples"],
    probes: [accessRolesDeny, sourcingDeny, suppliersDeny, samplesDeny],
  },
  {
    alias: "worker-a",
    expectedRole: "worker",
    requiredCapabilities: ["work:report"],
    forbiddenCapabilities: ["access:admin", "sourcing:view", "supplier_profile:read", "sample:view_basic"],
    allowedModules: ["rework"],
    forbiddenModules: ["sourcing", "suppliers", "production", "samples"],
    probes: [accessRolesDeny, sourcingDeny, suppliersDeny, samplesDeny],
  },
  {
    alias: "worker-b",
    expectedRole: "worker",
    requiredCapabilities: ["work:report"],
    forbiddenCapabilities: ["access:admin", "sourcing:view", "supplier_profile:read", "sample:view_basic"],
    allowedModules: ["rework"],
    forbiddenModules: ["sourcing", "suppliers", "production", "samples"],
    probes: [accessRolesDeny, sourcingDeny, suppliersDeny, samplesDeny],
  },
  {
    alias: "merchandiser",
    expectedRole: "order_merchandiser",
    requiredCapabilities: ["sourcing:view", "sourcing:inquiry:create", "supplier_profile:read"],
    forbiddenCapabilities: ["sample:view_basic", "access:admin"],
    allowedModules: ["rework", "sourcing", "suppliers", "production"],
    forbiddenModules: ["samples"],
    probes: [accessRolesDeny, sourcingAllow, suppliersAllow, samplesDeny],
  },
  {
    alias: "finance-read",
    expectedRole: "finance_read",
    requiredCapabilities: ["report:view"],
    forbiddenCapabilities: ["sample:view_basic", "access:admin"],
    probes: [accessRolesDeny, samplesDeny],
  },
  {
    alias: "finance-director",
    expectedRole: "finance_director",
    requiredCapabilities: ["sourcing:view", "sample:view_basic"],
    forbiddenCapabilities: ["access:admin"],
    allowedModules: ["rework", "sourcing", "suppliers", "samples"],
    forbiddenModules: ["production"],
    probes: [accessRolesDeny, sourcingAllow, suppliersAllow, samplesAllow],
  },
  {
    alias: "factory-payables",
    expectedRole: "factory_payables",
    requiredCapabilities: ["sourcing:view", "supplier_profile:read"],
    forbiddenCapabilities: ["sample:view_basic", "access:admin"],
    allowedModules: ["sourcing", "suppliers"],
    forbiddenModules: ["samples", "production"],
    probes: [accessRolesDeny, sourcingAllow, suppliersAllow, samplesDeny],
  },
  {
    alias: "system-admin",
    expectedRole: "system_admin",
    requiredCapabilities: ["admin:read", "audit:read"],
    forbiddenCapabilities: ["sample:view_basic", "sourcing:view"],
    forbiddenModules: ["sourcing", "suppliers", "production", "samples"],
    probes: [accessRolesDeny, sourcingDeny, suppliersDeny, samplesDeny],
  },
  {
    alias: "production-reporter",
    expectedRole: "production_reporter",
    requiredCapabilities: ["production-reporting"],
    forbiddenCapabilities: ["sample:view_basic", "access:admin"],
    allowedModules: ["production"],
    forbiddenModules: ["sourcing", "suppliers", "samples"],
    probes: [accessRolesDeny, sourcingDeny, suppliersDeny, samplesDeny],
  },
  {
    alias: "sample-designer",
    expectedRole: "sample_designer",
    requiredCapabilities: ["sample:view_basic"],
    forbiddenCapabilities: ["sample:view_finance", "sourcing:view", "access:admin"],
    allowedModules: ["samples"],
    forbiddenModules: ["sourcing", "suppliers", "production"],
    probes: [accessRolesDeny, sourcingDeny, suppliersDeny, samplesAllow],
  },
  {
    alias: "sample-admin",
    expectedRole: "sample_administrative",
    requiredCapabilities: ["sample:view_basic"],
    forbiddenCapabilities: ["sample:view_finance", "sourcing:view", "access:admin"],
    allowedModules: ["samples"],
    forbiddenModules: ["sourcing", "suppliers", "production"],
    probes: [accessRolesDeny, sourcingDeny, suppliersDeny, samplesAllow],
  },
  {
    alias: "sample-finance",
    expectedRole: "sample_finance",
    requiredCapabilities: ["sample:view_basic", "sample:view_finance"],
    forbiddenCapabilities: ["sourcing:view", "access:admin"],
    allowedModules: ["samples"],
    forbiddenModules: ["sourcing", "suppliers", "production"],
    probes: [accessRolesDeny, sourcingDeny, suppliersDeny, samplesAllow],
  },
  {
    alias: "sample-approver",
    expectedRole: "sample_approver",
    requiredCapabilities: ["sample:view_basic", "sample:view_finance", "sample:view_audit"],
    forbiddenCapabilities: ["sourcing:view", "access:admin"],
    allowedModules: ["samples"],
    forbiddenModules: ["sourcing", "suppliers", "production"],
    probes: [accessRolesDeny, sourcingDeny, suppliersDeny, samplesAllow],
  },
];

const check = (
  key: string,
  category: AcceptanceMatrixCheck["category"],
  label: string,
  expected: string,
  actual: string,
  passed: boolean,
): AcceptanceMatrixCheck => ({ key, category, label, expected, actual, verdict: passed ? "pass" : "fail" });

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
  ));
  checks.push(check(
    `${expectation.alias}:session-role`,
    "session",
    "业务 Session 角色",
    expectation.expectedRole,
    sessionRoles.join(", ") || "无",
    sessionRoles.length === 1 && sessionRoles[0] === expectation.expectedRole,
  ));
  const rootExpected = expectation.expectedRoot === true;
  checks.push(check(
    `${expectation.alias}:root`,
    "session",
    "Root 身份",
    rootExpected ? "是" : "否",
    user.isRoot ? "是" : "否",
    user.isRoot === rootExpected,
  ));

  for (const capability of expectation.requiredCapabilities ?? []) {
    checks.push(check(
      `${expectation.alias}:cap:${capability}:allow`,
      "capability",
      `应有 ${capability}`,
      "允许",
      user.capabilities.includes(capability) ? "允许" : "缺失",
      user.capabilities.includes(capability),
    ));
  }
  for (const capability of expectation.forbiddenCapabilities ?? []) {
    checks.push(check(
      `${expectation.alias}:cap:${capability}:deny`,
      "capability",
      `不得有 ${capability}`,
      "拒绝",
      user.capabilities.includes(capability) ? "意外允许" : "拒绝",
      !user.capabilities.includes(capability),
    ));
  }

  const actualModules = new Set(accessiblePlatformModules(user).map((module) => module.id));
  for (const moduleId of expectation.allowedModules ?? []) {
    checks.push(check(
      `${expectation.alias}:module:${moduleId}:allow`,
      "module",
      `模块 ${moduleId}`,
      "可进入",
      actualModules.has(moduleId) ? "可进入" : "不可进入",
      actualModules.has(moduleId),
    ));
  }
  for (const moduleId of expectation.forbiddenModules ?? []) {
    checks.push(check(
      `${expectation.alias}:module:${moduleId}:deny`,
      "module",
      `模块 ${moduleId}`,
      "不可进入",
      actualModules.has(moduleId) ? "意外可进入" : "不可进入",
      !actualModules.has(moduleId),
    ));
  }
  return checks;
}

export function evaluateHttpProbe(
  alias: string,
  probeDefinition: AcceptanceHttpProbe,
  actualStatus: number,
): AcceptanceMatrixCheck {
  return check(
    `${alias}:http:${probeDefinition.id}`,
    "http",
    probeDefinition.label,
    `HTTP ${probeDefinition.expectedStatus}`,
    `HTTP ${actualStatus}`,
    actualStatus === probeDefinition.expectedStatus,
  );
}
