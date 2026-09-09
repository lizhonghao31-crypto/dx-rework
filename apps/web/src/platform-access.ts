export type PlatformAccessModuleId = "rework" | "sourcing" | "suppliers" | "production" | "samples" | "platform";
export type TodoAccessModuleId = "rework" | "sourcing" | "production" | "samples";

export type PlatformRoleAccess = Readonly<{
  roleCode: string;
  capabilities: readonly string[];
}>;

export const PLATFORM_ACCESS_MODULE_ORDER: readonly PlatformAccessModuleId[] = [
  "rework",
  "sourcing",
  "suppliers",
  "production",
  "samples",
  "platform",
];

const PROTECTED_ROLE_MODULES: Readonly<Record<string, readonly PlatformAccessModuleId[]>> = {
  owner_group: PLATFORM_ACCESS_MODULE_ORDER,
  system_admin: ["platform"],
  tail_inspector: ["rework"],
};

export const PLATFORM_ACCESS_MODULE_LABELS: Record<PlatformAccessModuleId, string> = {
  rework: "订单返工",
  sourcing: "外发定价&选厂",
  suppliers: "供应商中心",
  production: "实时生产看板",
  samples: "样衣管理",
  platform: "平台管理",
};

const isPlatformCapability = (capability: string): boolean =>
  capability.startsWith("access:")
  || capability.startsWith("admin:")
  || capability.startsWith("audit:")
  || capability.startsWith("master_data:")
  || capability.startsWith("delegation:");

const REWORK_CAPABILITY_PREFIXES = [
  "dashboard:",
  "rework:",
  "receiving:",
  "process:",
  "task:",
  "submission:",
  "quantity:",
  "liability:",
  "own_factory:",
  "external_liability:",
  "deduction:",
  "payroll:",
  "finance:",
  "wage:",
  "work:",
  "tail_inspection:",
  "responsibility:",
  "settlement:",
  "report:",
] as const;

const TODO_REWORK_CAPABILITY_PREFIXES = REWORK_CAPABILITY_PREFIXES.filter(
  (prefix) => prefix !== "receiving:" && prefix !== "report:",
);

const isReworkCapability = (capability: string): boolean =>
  REWORK_CAPABILITY_PREFIXES.some((prefix) => capability.startsWith(prefix));

const isTodoReworkCapability = (capability: string): boolean =>
  TODO_REWORK_CAPABILITY_PREFIXES.some((prefix) => capability.startsWith(prefix));

export function accessModuleIdsForCapabilities(
  capabilities: readonly string[],
): PlatformAccessModuleId[] {
  const modules = new Set<PlatformAccessModuleId>();
  for (const capability of capabilities) {
    if (capability === "production-reporting") {
      modules.add("production");
    } else if (capability.startsWith("sourcing:")) {
      modules.add("sourcing");
    } else if (capability.startsWith("supplier_profile:")) {
      modules.add("suppliers");
    } else if (capability.startsWith("sample:")) {
      modules.add("samples");
    } else if (isPlatformCapability(capability)) {
      modules.add("platform");
    } else if (isReworkCapability(capability)) {
      modules.add("rework");
    }
  }
  return PLATFORM_ACCESS_MODULE_ORDER.filter((moduleId) => modules.has(moduleId));
}

export function accessModuleLabelsForCapabilities(
  capabilities: readonly string[],
): string[] {
  return accessModuleIdsForCapabilities(capabilities)
    .map((moduleId) => PLATFORM_ACCESS_MODULE_LABELS[moduleId]);
}

export function accessModuleIdsForRole(
  roleCode: string,
  capabilities: readonly string[] = [],
): PlatformAccessModuleId[] {
  const modules = new Set<PlatformAccessModuleId>(
    PROTECTED_ROLE_MODULES[roleCode] ?? accessModuleIdsForCapabilities(capabilities),
  );
  if (
    ["production_management", "order_merchandiser"].includes(roleCode)
    && capabilities.includes("sourcing:view")
  ) {
    modules.add("production");
  }
  return PLATFORM_ACCESS_MODULE_ORDER.filter((moduleId) => modules.has(moduleId));
}

export function accessModuleLabelsForRole(
  roleCode: string,
  capabilities: readonly string[] = [],
): string[] {
  return accessModuleIdsForRole(roleCode, capabilities)
    .map((moduleId) => PLATFORM_ACCESS_MODULE_LABELS[moduleId]);
}

export function employeeHasAccessModule(
  businessRoles: readonly string[],
  roles: readonly PlatformRoleAccess[],
  moduleId: PlatformAccessModuleId,
): boolean {
  const roleByCode = new Map(roles.map((role) => [role.roleCode, role]));
  return businessRoles.some((roleCode) =>
    accessModuleIdsForRole(
      roleCode,
      roleByCode.get(roleCode)?.capabilities ?? [],
    ).includes(moduleId));
}

const todoBaseModuleIdsForCapabilities = (capabilities: readonly string[]): TodoAccessModuleId[] => {
  const modules = new Set<TodoAccessModuleId>();
  for (const capability of capabilities) {
    if (capability === "production-reporting") {
      modules.add("production");
    } else if (capability.startsWith("sourcing:")) {
      modules.add("sourcing");
    } else if (isTodoReworkCapability(capability)) {
      modules.add("rework");
    }
  }
  return (["rework", "sourcing", "production"] as const).filter((moduleId) => modules.has(moduleId));
};

const todoBaseModuleIdsForRole = (
  roleCode: string,
  capabilities: readonly string[],
): TodoAccessModuleId[] => {
  if (roleCode === "owner_group") return ["rework", "sourcing", "production"];
  if (roleCode === "tail_inspector") return ["rework"];
  if (roleCode === "system_admin") return [];
  return todoBaseModuleIdsForCapabilities(capabilities);
};

export function todoModuleIdsForUser(user: Readonly<{
  businessRoles?: readonly string[];
  capabilities: readonly string[];
  isRoot?: boolean;
}>): TodoAccessModuleId[] {
  if (user.isRoot) return ["rework", "sourcing", "production", "samples"];

  const roles = user.businessRoles ?? [];
  const classified = roles.length > 0
    ? roles.flatMap((roleCode) => todoBaseModuleIdsForRole(roleCode, user.capabilities))
    : todoBaseModuleIdsForCapabilities(user.capabilities);
  const modules = new Set<TodoAccessModuleId>(classified);
  if (user.capabilities.includes("todo:view") && user.capabilities.includes("sample:view_basic") && roles.some(role => ["sample_designer", "sample_administrative", "sample_finance", "sample_approver", "owner_group"].includes(role))) modules.add("samples");
  if (user.capabilities.includes("todo:view") && user.capabilities.includes("sourcing:view") && roles.some(role=>["order_merchandiser","production_management","owner_group"].includes(role))) modules.add("production");
  else modules.delete("production");
  return (["rework", "sourcing", "production", "samples"] as const).filter((moduleId) => modules.has(moduleId));
}
