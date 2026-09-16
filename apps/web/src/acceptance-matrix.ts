import type { AuthorizedUser } from "./auth.js";
import { accessiblePlatformModules } from "./platform-modules.js";

export type AcceptanceModuleId = "rework" | "sourcing" | "suppliers" | "production" | "samples" | "finance" | "pattern_room";
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
const approvedKeys = (ruleId: string, keys: readonly string[]): Record<string, AcceptanceRuleRef> =>
  Object.fromEntries(keys.map((key) => [key, approved(ruleId)]));

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
 * The matrix translates the approved Golden Source. Every current business
 * check is explicitly bound by key. A future capability/module/HTTP check that
 * is added without a ruleRefs entry is quarantined as unmapped instead of
 * inheriting an unrelated role-level approval.
 */
const EXISTING_ACCEPTANCE_ROLE_MATRIX: readonly AcceptanceRoleExpectation[] = [
  {
    alias: "root",
    expectedRole: "owner_group",
    expectedRoot: true,
    allowedModules: ["rework", "sourcing", "suppliers", "production", "samples"],
    probes: [accessRolesAllow, sourcingAllow, suppliersAllow, productionDashboardAllow, samplesAllow],
    ruleRefs: approvedKeys("PERM-PLATFORM-ROOT-001", [
      "module:rework:allow", "module:sourcing:allow", "module:suppliers:allow", "module:production:allow", "module:samples:allow",
      "http:access-roles", "http:sourcing-list", "http:supplier-list", "http:production-dashboard", "http:sample-list",
    ]),
  },
  {
    alias: "owner",
    expectedRole: "owner_group",
    requiredCapabilities: ["todo:view", "sourcing:view", "supplier_profile:read", "sample:view_basic"],
    forbiddenCapabilities: ["access:admin", "admin:read", "audit:read"],
    allowedModules: ["rework", "sourcing", "suppliers", "production", "samples"],
    probes: [accessRolesDeny, sourcingAllow, suppliersAllow, productionDashboardAllow, samplesAllow],
    ruleRefs: {
      ...approvedKeys("PERM-PLATFORM-OWNER-001", [
        "cap:todo:view:allow", "cap:sourcing:view:allow", "cap:sample:view_basic:allow",
        "cap:access:admin:deny", "cap:admin:read:deny", "cap:audit:read:deny",
        "module:rework:allow", "module:sourcing:allow", "module:production:allow", "module:samples:allow",
        "http:sourcing-list", "http:production-dashboard", "http:sample-list",
      ]),
      "cap:supplier_profile:read:allow": approved("PERM-SUPPLIER-OWNER-001"),
      "module:suppliers:allow": approved("PERM-SUPPLIER-OWNER-001"),
      "http:supplier-list": approved("PERM-SUPPLIER-OWNER-001"),
      "http:access-roles": approved("PERM-PLATFORM-ACCESS-ADMIN-001"),
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
      ...approvedKeys("PERM-ROLE-PRODUCTION-MANAGEMENT-001", [
        "cap:sample:view_basic:deny", "cap:access:admin:deny", "module:rework:allow", "module:production:allow",
        "module:samples:deny", "http:production-dashboard", "http:sample-list",
      ]),
      "cap:sourcing:view:allow": approved("PERM-SOURCING-FIVE-001"),
      "module:sourcing:allow": approved("PERM-SOURCING-FIVE-001"),
      "http:sourcing-list": approved("PERM-SOURCING-FIVE-001"),
      "module:suppliers:allow": approved("PERM-SUPPLIER-PM-CENTER-001"),
      "http:supplier-list": approved("PERM-SUPPLIER-PM-CENTER-001"),
      "http:access-roles": approved("PERM-PLATFORM-ACCESS-ADMIN-001"),
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
      ...approvedKeys("PERM-ROLE-IE-001", [
        "cap:process:review:allow", "cap:sample:view_basic:deny", "cap:access:admin:deny", "module:rework:allow",
        "module:samples:deny", "module:production:deny", "http:production-dashboard", "http:sample-list",
      ]),
      "cap:sourcing:view:allow": approved("PERM-SOURCING-FIVE-001"),
      "module:sourcing:allow": approved("PERM-SOURCING-FIVE-001"),
      "http:sourcing-list": approved("PERM-SOURCING-FIVE-001"),
      "module:suppliers:allow": approved("PERM-SUPPLIER-IE-CENTER-001"),
      "http:supplier-list": approved("PERM-SUPPLIER-IE-CENTER-001"),
      "http:access-roles": approved("PERM-PLATFORM-ACCESS-ADMIN-001"),
    },
  },
  {
    alias: "tail-supervisor",
    expectedRole: "tail_supervisor",
    requiredCapabilities: ["process:configure", "work:assign"],
    forbiddenCapabilities: ["sourcing:view", "sample:view_basic", "access:admin"],
    allowedModules: ["rework"],
    forbiddenModules: ["sourcing", "suppliers", "production", "samples"],
    probes: [accessRolesDeny, sourcingDeny, suppliersDeny, productionDashboardDeny, samplesDeny],
    ruleRefs: {
      ...approvedKeys("PERM-ROLE-TAIL-SUPERVISOR-001", [
        "cap:process:configure:allow", "cap:work:assign:allow", "cap:sourcing:view:deny", "cap:sample:view_basic:deny", "cap:access:admin:deny",
        "module:rework:allow", "module:sourcing:deny", "module:production:deny", "module:samples:deny",
        "http:sourcing-list", "http:production-dashboard", "http:sample-list",
      ]),
      "module:suppliers:deny": approved("PERM-SUPPLIER-TAIL-001"),
      "http:supplier-list": approved("PERM-SUPPLIER-TAIL-001"),
      "http:access-roles": approved("PERM-PLATFORM-ACCESS-ADMIN-001"),
    },
  },
  {
    alias: "qc",
    expectedRole: "quality_control",
    requiredCapabilities: ["rework:initiate"],
    forbiddenCapabilities: ["sourcing:view", "sample:view_basic", "access:admin"],
    allowedModules: ["rework"],
    forbiddenModules: ["sourcing", "suppliers", "production", "samples"],
    probes: [accessRolesDeny, sourcingDeny, suppliersDeny, productionDashboardDeny, samplesDeny],
    ruleRefs: {
      ...approvedKeys("PERM-ROLE-QC-001", [
        "cap:rework:initiate:allow", "cap:sourcing:view:deny", "cap:sample:view_basic:deny", "cap:access:admin:deny",
        "module:rework:allow", "module:sourcing:deny", "module:production:deny", "module:samples:deny",
        "http:sourcing-list", "http:production-dashboard", "http:sample-list",
      ]),
      "module:suppliers:deny": approved("PERM-SUPPLIER-QC-001"),
      "http:supplier-list": approved("PERM-SUPPLIER-QC-001"),
      "http:access-roles": approved("PERM-PLATFORM-ACCESS-ADMIN-001"),
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
      ...approvedKeys("PERM-ROLE-WAREHOUSE-001", [
        "cap:receiving:create:allow", "cap:sourcing:view:deny", "cap:sample:view_basic:deny", "cap:access:admin:deny",
        "module:rework:allow", "module:sourcing:deny", "module:production:deny", "module:samples:deny",
        "http:sourcing-list", "http:production-dashboard", "http:sample-list",
      ]),
      "module:suppliers:deny": approved("PERM-SUPPLIER-WAREHOUSE-001"),
      "http:supplier-list": approved("PERM-SUPPLIER-WAREHOUSE-001"),
      "http:access-roles": approved("PERM-PLATFORM-ACCESS-ADMIN-001"),
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
      "http:access-roles": approved("PERM-PLATFORM-ACCESS-ADMIN-001"),
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
      "http:access-roles": approved("PERM-PLATFORM-ACCESS-ADMIN-001"),
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
      ...approvedKeys("PERM-ROLE-MERCHANDISER-001", [
        "cap:sample:view_basic:deny", "cap:access:admin:deny", "module:rework:allow", "module:production:allow",
        "module:samples:deny", "http:production-dashboard", "http:sample-list",
      ]),
      "cap:sourcing:view:allow": approved("PERM-SOURCING-FIVE-001"),
      "cap:sourcing:inquiry:create:allow": approved("PERM-SOURCING-FIVE-001"),
      "module:sourcing:allow": approved("PERM-SOURCING-FIVE-001"),
      "http:sourcing-list": approved("PERM-SOURCING-FIVE-001"),
      "cap:supplier_profile:read:allow": approved("PERM-SUPPLIER-MERCH-CENTER-001"),
      "module:suppliers:allow": approved("PERM-SUPPLIER-MERCH-CENTER-001"),
      "http:supplier-list": approved("PERM-SUPPLIER-MERCH-CENTER-001"),
      "http:access-roles": approved("PERM-PLATFORM-ACCESS-ADMIN-001"),
    },
  },
  {
    alias: "embroidery-washing-merchandiser",
    expectedRole: "embroidery_washing_merchandiser",
    requiredCapabilities: ["external_responsibility:view"],
    forbiddenCapabilities: ["access:admin"],
    allowedModules: ["rework"],
    probes: [accessRolesDeny],
    ruleRefs: {
      ...approvedKeys("PERM-ROLE-EMBROIDERY-WASH-MERCH-001", [
        "cap:external_responsibility:view:allow", "cap:access:admin:deny", "module:rework:allow",
      ]),
      "http:access-roles": approved("PERM-PLATFORM-ACCESS-ADMIN-001"),
    },
  },
  {
    alias: "finance-read",
    expectedRole: "finance_read",
    requiredCapabilities: ["report:view", "sourcing:view", "supplier_profile:read", "supplier_contract_data:read", "sample:view_basic", "sample:view_finance", "sample:view_audit", "rework:finance_nodes:read", "pattern_room:catalog:read", "pattern_room:misc:quote"],
    forbiddenCapabilities: ["access:admin", "production-reporting", "external_deduction:special_approve", "report:export", "receiving:export", ...sampleMutationCapabilities],
    allowedModules: ["rework", "sourcing", "suppliers", "production", "samples"],
    probes: [accessRolesDeny, reworkReportAllow, sourcingAllow, suppliersAllow, productionDashboardAllow, samplesAllow],
    ruleRefs: {
      ...approvedKeys("PERM-ROLE-FINANCE-READ-001", [
        ...["report:view", "sourcing:view", "supplier_profile:read", "supplier_contract_data:read", "sample:view_basic", "sample:view_finance", "sample:view_audit", "rework:finance_nodes:read", "pattern_room:catalog:read", "pattern_room:misc:quote"].map(cap => `cap:${cap}:allow`),
        ...["access:admin", "production-reporting", "external_deduction:special_approve", "report:export", "receiving:export", ...sampleMutationCapabilities].map(cap => `cap:${cap}:deny`),
        ...["rework", "sourcing", "suppliers", "production", "samples"].map(module => `module:${module}:allow`),
        "http:sourcing-list", "http:supplier-list", "http:production-dashboard", "http:sample-list", "http:rework-report-list",
      ]),
      "http:access-roles": approved("PERM-PLATFORM-ACCESS-ADMIN-001"),
    },
  },
  {
    alias: "finance-director",
    expectedRole: "finance_director",
    requiredCapabilities: ["sourcing:view", "sample:view_basic", "sample:view_finance", "sample:view_audit"],
    forbiddenCapabilities: ["access:admin", "production-reporting", ...sampleMutationCapabilities],
    allowedModules: ["rework", "sourcing", "suppliers", "production", "samples"],
    probes: [accessRolesDeny, sourcingAllow, suppliersAllow, productionDashboardAllow, samplesAllow],
    ruleRefs: {
      ...approvedKeys("PERM-ROLE-FINANCE-DIRECTOR-001", [
        "cap:access:admin:deny", "cap:production-reporting:deny", "module:production:allow", "http:production-dashboard",
      ]),
      "cap:sourcing:view:allow": approved("PERM-SOURCING-FIVE-001"),
      "module:sourcing:allow": approved("PERM-SOURCING-FIVE-001"),
      "http:sourcing-list": approved("PERM-SOURCING-FIVE-001"),
      "cap:sample:view_basic:allow": approved("PERM-SAMPLE-FINANCE-DIRECTOR-001"),
      "cap:sample:view_finance:allow": approved("PERM-SAMPLE-FINANCE-DIRECTOR-001"),
      "cap:sample:view_audit:allow": approved("PERM-SAMPLE-FINANCE-DIRECTOR-001"),
      ...sampleMutationDenyRules,
      "module:samples:allow": approved("PERM-SAMPLE-FINANCE-DIRECTOR-001"),
      "http:sample-list": approved("PERM-SAMPLE-FINANCE-DIRECTOR-001"),
      "module:rework:allow": approved("PERM-REWORK-FINANCE-DIRECTOR-001"),
      "module:suppliers:allow": approved("PERM-SUPPLIER-FINANCE-CENTER-001"),
      "http:supplier-list": approved("PERM-SUPPLIER-FINANCE-CENTER-001"),
      "http:access-roles": approved("PERM-PLATFORM-ACCESS-ADMIN-001"),
    },
  },
  {
    alias: "factory-payables",
    expectedRole: "factory_payables",
    requiredCapabilities: ["sourcing:view", "supplier_profile:read", "external_responsibility:payables_confirm"],
    forbiddenCapabilities: ["sample:view_basic", "access:admin"],
    allowedModules: ["rework", "sourcing", "suppliers"],
    forbiddenModules: ["samples", "production"],
    probes: [accessRolesDeny, sourcingAllow, suppliersAllow, productionDashboardDeny, samplesDeny],
    ruleRefs: {
      ...approvedKeys("PERM-ROLE-PAYABLES-001", [
        "cap:sourcing:view:allow", "cap:external_responsibility:payables_confirm:allow", "cap:sample:view_basic:deny", "cap:access:admin:deny",
        "module:rework:allow", "module:sourcing:allow", "module:samples:deny", "module:production:deny",
        "http:sourcing-list", "http:production-dashboard", "http:sample-list",
      ]),
      "cap:supplier_profile:read:allow": approved("PERM-SUPPLIER-FACTORY-PAYABLES-CENTER-001"),
      "module:suppliers:allow": approved("PERM-SUPPLIER-FACTORY-PAYABLES-CENTER-001"),
      "http:supplier-list": approved("PERM-SUPPLIER-FACTORY-PAYABLES-CENTER-001"),
      "http:access-roles": approved("PERM-PLATFORM-ACCESS-ADMIN-001"),
    },
  },
  {
    alias: "embroidery-washing-payables",
    expectedRole: "embroidery_washing_payables",
    requiredCapabilities: ["external_responsibility:view", "external_responsibility:payables_confirm"],
    forbiddenCapabilities: ["access:admin"],
    allowedModules: ["rework"],
    probes: [accessRolesDeny],
    ruleRefs: {
      ...approvedKeys("PERM-ROLE-PAYABLES-001", [
        "cap:external_responsibility:view:allow", "cap:external_responsibility:payables_confirm:allow", "cap:access:admin:deny", "module:rework:allow",
      ]),
      "http:access-roles": approved("PERM-PLATFORM-ACCESS-ADMIN-001"),
    },
  },
  {
    alias: "fabric-payables",
    expectedRole: "fabric_payables",
    requiredCapabilities: ["external_responsibility:view", "external_responsibility:payables_confirm"],
    forbiddenCapabilities: ["access:admin"],
    allowedModules: ["rework"],
    probes: [accessRolesDeny],
    ruleRefs: {
      ...approvedKeys("PERM-ROLE-PAYABLES-001", [
        "cap:external_responsibility:view:allow", "cap:external_responsibility:payables_confirm:allow", "cap:access:admin:deny", "module:rework:allow",
      ]),
      "http:access-roles": approved("PERM-PLATFORM-ACCESS-ADMIN-001"),
    },
  },
  {
    alias: "wage-month-close-accountant",
    expectedRole: "wage_month_close_accountant",
    requiredCapabilities: ["wage:view", "wage:export"],
    forbiddenCapabilities: ["access:admin", "report:export", "sourcing:view", "supplier_profile:read", "sample:view_basic"],
    allowedModules: ["rework"],
    forbiddenModules: ["sourcing", "suppliers", "production", "samples"],
    probes: [accessRolesDeny, sourcingDeny, suppliersDeny, productionDashboardDeny, samplesDeny],
    ruleRefs: {
      ...approvedKeys("PERM-WAGE-MONTH-CLOSE-EXPORT-001", [
        "cap:wage:view:allow", "cap:wage:export:allow", "cap:access:admin:deny", "cap:report:export:deny", "cap:sourcing:view:deny",
        "cap:supplier_profile:read:deny", "cap:sample:view_basic:deny", "module:rework:allow", "module:sourcing:deny", "module:suppliers:deny",
        "module:production:deny", "module:samples:deny", "http:sourcing-list", "http:supplier-list", "http:production-dashboard", "http:sample-list",
      ]),
      "http:access-roles": approved("PERM-PLATFORM-ACCESS-ADMIN-001"),
    },
  },
  {
    alias: "system-admin",
    expectedRole: "system_admin",
    requiredCapabilities: ["admin:read", "audit:read"],
    forbiddenCapabilities: ["access:admin", "sample:view_basic", "sourcing:view", "supplier_profile:read", "production-reporting"],
    forbiddenModules: ["sourcing", "suppliers", "production", "samples"],
    probes: [accessRolesDeny, sourcingDeny, suppliersDeny, productionDashboardDeny, samplesDeny],
    ruleRefs: {
      ...approvedKeys("PERM-PLATFORM-SYSADMIN-001", [
        "cap:admin:read:allow", "cap:audit:read:allow", "cap:access:admin:deny", "cap:sample:view_basic:deny", "cap:sourcing:view:deny",
        "cap:supplier_profile:read:deny", "cap:production-reporting:deny", "module:sourcing:deny", "module:suppliers:deny", "module:production:deny",
        "module:samples:deny", "http:sourcing-list", "http:supplier-list", "http:production-dashboard", "http:sample-list",
      ]),
      "http:access-roles": approved("PERM-PLATFORM-ACCESS-ADMIN-001"),
    },
  },
  {
    alias: "production-reporter",
    expectedRole: "production_reporter",
    requiredCapabilities: ["production-reporting"],
    forbiddenCapabilities: ["sample:view_basic", "access:admin", "sourcing:view", "supplier_profile:read"],
    allowedModules: ["production"],
    forbiddenModules: ["sourcing", "suppliers", "samples"],
    probes: [accessRolesDeny, sourcingDeny, suppliersDeny, productionDashboardAllow, samplesDeny],
    ruleRefs: {
      ...approvedKeys("PERM-PRODUCTION-REPORTER-001", [
        "cap:production-reporting:allow", "cap:sample:view_basic:deny", "cap:access:admin:deny", "cap:sourcing:view:deny", "cap:supplier_profile:read:deny",
        "module:production:allow", "module:sourcing:deny", "module:suppliers:deny", "module:samples:deny",
        "http:sourcing-list", "http:supplier-list", "http:production-dashboard", "http:sample-list",
      ]),
      "http:access-roles": approved("PERM-PLATFORM-ACCESS-ADMIN-001"),
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
      ...approvedKeys("PERM-SAMPLE-DESIGNER-001", [
        "cap:sample:view_basic:allow", "cap:sample:view_finance:deny", "cap:sourcing:view:deny", "cap:access:admin:deny", "module:samples:allow",
        "module:sourcing:deny", "module:suppliers:deny", "module:production:deny", "http:sourcing-list", "http:supplier-list", "http:production-dashboard", "http:sample-list",
      ]),
      "http:access-roles": approved("PERM-PLATFORM-ACCESS-ADMIN-001"),
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
      ...approvedKeys("PERM-SAMPLE-ADMIN-001", [
        "cap:sample:view_basic:allow", "cap:sample:view_finance:deny", "cap:sourcing:view:deny", "cap:access:admin:deny", "module:samples:allow",
        "module:sourcing:deny", "module:suppliers:deny", "module:production:deny", "http:sourcing-list", "http:supplier-list", "http:production-dashboard", "http:sample-list",
      ]),
      "http:access-roles": approved("PERM-PLATFORM-ACCESS-ADMIN-001"),
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
      ...approvedKeys("PERM-SAMPLE-FINANCE-001", [
        "cap:sample:view_basic:allow", "cap:sample:view_finance:allow", "cap:sourcing:view:deny", "cap:access:admin:deny", "module:samples:allow",
        "module:sourcing:deny", "module:suppliers:deny", "module:production:deny", "http:sourcing-list", "http:supplier-list", "http:production-dashboard", "http:sample-list",
      ]),
      "http:access-roles": approved("PERM-PLATFORM-ACCESS-ADMIN-001"),
    },
  },
];

// Approved 2026-09-12 scope, explicitly translated from the business plan.
// Approved PR03/04/05 roles; ordinary order operations remain closed until PR06.
const patternOrderRoles: Record<string, readonly string[]> = {
  "pattern_room:orders:delete": ["root_superuser"],
  "pattern_room:orders:view": ["sample_designer", "order_merchandiser", "pattern_room_supervisor", "pattern_room_worker", "owner_group", "production_management", "finance_director", "finance_read", "wage_month_close_accountant"],
  "pattern_room:orders:create": ["sample_designer"], "pattern_room:orders:edit": ["sample_designer"],
  "pattern_room:orders:handoff": ["sample_designer"], "pattern_room:orders:assign": ["pattern_room_supervisor"], "pattern_room:orders:complete": ["pattern_room_worker"],
  "pattern_room:misc:create": ["sample_designer", "order_merchandiser"], "pattern_room:misc:edit": ["sample_designer", "order_merchandiser"],
  "pattern_room:misc:confirm": ["sample_designer", "order_merchandiser"], "pattern_room:orders:hours": ["pattern_room_supervisor"],
  "pattern_room:orders:rework": ["sample_designer", "pattern_room_supervisor"], "pattern_room:orders:transfer": ["pattern_room_supervisor"],
  "pattern_room:orders:cancel": ["sample_designer", "order_merchandiser", "pattern_room_supervisor"], "pattern_room:orders:cancel_fees": ["sample_designer"],
};

export const ACCEPTANCE_ROLE_MATRIX: readonly AcceptanceRoleExpectation[] = EXISTING_ACCEPTANCE_ROLE_MATRIX.map(entry => {
  const finance = ["root", "owner", "production-management", "finance-director", "finance-read", "wage-month-close-accountant"].includes(entry.alias);
  const mark = ["root", "finance-director", "finance-read", "wage-month-close-accountant"].includes(entry.alias);
  const readCaps = ["wage:view", "wage:export"];
  const required = entry.expectedRoot ? [] : [...(finance ? readCaps : []), ...(mark ? ["wage:settlement_mark"] : [])];
  const forbidden = [...(!finance ? readCaps : []), ...(!mark ? ["wage:settlement_mark"] : [])];
  return {
    ...entry,
    requiredCapabilities: [...new Set([...(entry.requiredCapabilities ?? []), ...required])],
    forbiddenCapabilities: [...new Set([...(entry.forbiddenCapabilities ?? []), ...forbidden])],
    allowedModules: [...(entry.allowedModules ?? []), ...(finance ? ["finance" as const] : [])],
    forbiddenModules: [...(entry.forbiddenModules ?? []), ...(!finance ? ["finance" as const] : [])],
    probes: [...(entry.probes ?? []), probe("finance-wages", "工资查询", "management/reports/wages", finance ? 200 : 403),
      probe("finance-wage-marker", "工资已结清权限", "management/wages/settlement-preview", mark ? 200 : 403)],
    ruleRefs: { ...entry.ruleRefs, ...approvedKeys("PERM-FINANCE-WAGE-20260912", [
      ...required.map(cap => `cap:${cap}:allow`), ...forbidden.map(cap => `cap:${cap}:deny`),
      `module:finance:${finance ? "allow" : "deny"}`, "http:finance-wages", "http:finance-wage-marker",
    ]) },
  };
 }).map(entry => {
  // PR02 approved field-level authority, independently transcribed from section 8.1.
  const root = entry.expectedRoot === true;
  const read = root || ["owner_group","production_management","finance_director","finance_read","pattern_room_supervisor"].includes(entry.expectedRole);
  const moduleAccess = read || ["sample_designer","order_merchandiser","pattern_room_worker","wage_month_close_accountant"].includes(entry.expectedRole);
  const category = root || ["owner_group","production_management"].includes(entry.expectedRole);
  const hourly = root || entry.expectedRole === "owner_group";
  const required = root ? [] : [...(read ? ["pattern_room:prices:read"] : []), ...(category ? ["pattern_room:prices:write"] : []), ...(hourly ? ["pattern_room:hourly:write"] : [])];
  const forbidden = [...(!read ? ["pattern_room:prices:read"] : []), ...(!category ? ["pattern_room:prices:write"] : []), ...(!hourly ? ["pattern_room:hourly:write"] : [])];
  return { ...entry,
    requiredCapabilities: [...(entry.requiredCapabilities ?? []), ...required],
    forbiddenCapabilities: [...(entry.forbiddenCapabilities ?? []), ...forbidden],
    allowedModules: [...(entry.allowedModules ?? []), ...(moduleAccess ? ["pattern_room" as const] : [])],
    forbiddenModules: [...(entry.forbiddenModules ?? []), ...(!moduleAccess ? ["pattern_room" as const] : [])],
    probes: [...(entry.probes ?? []), probe("pattern-room-prices","板房价格管控","pattern-room/prices",read ? 200 : 403)],
    ruleRefs: { ...entry.ruleRefs, ...approvedKeys(entry.expectedRole === "wage_month_close_accountant" ? "PERM-PATTERN-FINANCE-READ-20260915" : entry.expectedRole === "finance_read" ? "PERM-ROLE-FINANCE-READ-001" : "PERM-PATTERN-PRICE-20260912",[
      ...required.map(cap => `cap:${cap}:allow`), ...forbidden.map(cap => `cap:${cap}:deny`),
      `module:pattern_room:${moduleAccess ? "allow" : "deny"}`, "http:pattern-room-prices",
    ]) },
  };
}).map(entry => {
  const root = entry.expectedRoot === true;
  const required = root ? [] : Object.entries(patternOrderRoles).filter(([, roles]) => roles.includes(entry.expectedRole)).map(([capability]) => capability);
  const forbidden = root ? [] : Object.entries(patternOrderRoles).filter(([, roles]) => !roles.includes(entry.expectedRole)).map(([capability]) => capability);
  return { ...entry,
    requiredCapabilities: [...(entry.requiredCapabilities ?? []), ...required], forbiddenCapabilities: [...(entry.forbiddenCapabilities ?? []), ...forbidden],
    probes: [...(entry.probes ?? []), probe("pattern-room-orders", "首次打板开放边界", "pattern-room/orders", root ? 200 : required.includes("pattern_room:orders:view") ? 200 : 403)],
    ruleRefs: { ...entry.ruleRefs, ...approvedKeys(["finance_director","finance_read","wage_month_close_accountant"].includes(entry.expectedRole) ? "PERM-PATTERN-FINANCE-READ-20260915" : "PERM-PATTERN-ORDER-20260912", [...required.map(capability => `cap:${capability}:allow`), ...forbidden.map(capability => `cap:${capability}:deny`), "http:pattern-room-orders"]) },
  };
}).map(entry => {
  const allowed = ["owner_group", "production_management"].includes(entry.expectedRole);
  const capability = "supplier_profile:write";
  return { ...entry,
    requiredCapabilities: [...(entry.requiredCapabilities ?? []), ...(allowed ? [capability] : [])],
    forbiddenCapabilities: [...(entry.forbiddenCapabilities ?? []).filter(cap => cap !== capability), ...(!allowed && !entry.expectedRoot ? [capability] : [])],
    ruleRefs: { ...entry.ruleRefs, ...approvedKeys("PERM-SUPPLIER-MAINTAIN-001", [`cap:${capability}:${allowed ? "allow" : "deny"}`]) },
  };
}).map(entry => {
  const request = ["order_merchandiser", "embroidery_washing_merchandiser"].includes(entry.expectedRole);
  const approve = ["owner_group", "production_management"].includes(entry.expectedRole);
  const caps = { "supplier_onboarding:request": request, "supplier_onboarding:approve": approve };
  const required = Object.entries(caps).filter(([, allow]) => allow).map(([cap]) => cap);
  const forbidden = entry.expectedRoot ? [] : Object.entries(caps).filter(([, allow]) => !allow).map(([cap]) => cap);
  const embroidery = entry.expectedRole === "embroidery_washing_merchandiser";
  return { ...entry,
    requiredCapabilities: [...(entry.requiredCapabilities ?? []), ...required, ...(embroidery ? ["supplier_profile:read"] : [])],
    forbiddenCapabilities: [...(entry.forbiddenCapabilities ?? []).filter(cap => !embroidery || cap !== "supplier_profile:read"), ...forbidden],
    allowedModules: [...(entry.allowedModules ?? []), ...(embroidery ? ["suppliers" as const] : [])],
    forbiddenModules: (entry.forbiddenModules ?? []).filter(module => !embroidery || module !== "suppliers"),
    probes: [...(entry.probes ?? []), probe("supplier-applications", "供应商申请记录边界", "supplier-onboarding/requests?scope=mine", entry.expectedRoot || request || approve ? 200 : 403)],
    ruleRefs: { ...entry.ruleRefs, ...approvedKeys("PERM-SUPPLIER-ONBOARDING-001", [
      ...required.map(cap => `cap:${cap}:allow`), ...forbidden.map(cap => `cap:${cap}:deny`), "http:supplier-applications",
      ...(embroidery ? ["cap:supplier_profile:read:allow", "module:suppliers:allow"] : []),
    ]) },
  };
 }).map(entry => {
  const allowed = {"receiving:resolve_difference": entry.expectedRole === "order_merchandiser", "receiving:packing_manage": entry.expectedRole === "warehouse_receiver"};
  const required = entry.expectedRoot ? [] : Object.entries(allowed).filter(([,value])=>value).map(([cap])=>cap);
  const forbidden = entry.expectedRoot ? [] : Object.entries(allowed).filter(([,value])=>!value).map(([cap])=>cap);
  return {...entry,requiredCapabilities:[...(entry.requiredCapabilities??[]),...required],forbiddenCapabilities:[...(entry.forbiddenCapabilities??[]),...forbidden],
    ruleRefs:{...entry.ruleRefs,...approvedKeys("PERM-RECEIVING-DIFFERENCE-20260916",[...required.map(cap=>`cap:${cap}:allow`),...forbidden.map(cap=>`cap:${cap}:deny`)])}};
});


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
