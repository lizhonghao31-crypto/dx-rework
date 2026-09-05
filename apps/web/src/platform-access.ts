export type PlatformAccessModuleId = "rework" | "sourcing" | "production" | "platform";
export type TodoAccessModuleId = Extract<PlatformAccessModuleId, "rework" | "sourcing" | "production">;

export type PlatformRoleAccess = Readonly<{
  roleCode: string;
  capabilities: readonly string[];
}>;

const MODULE_ORDER: readonly PlatformAccessModuleId[] = ["rework", "sourcing", "production", "platform"];

const PROTECTED_ROLE_MODULES: Readonly<Record<string, readonly PlatformAccessModuleId[]>> = {
  owner_group: MODULE_ORDER,
  system_admin: ["platform"],
  tail_inspector: ["rework"],
};

export const PLATFORM_ACCESS_MODULE_LABELS: Record<PlatformAccessModuleId, string> = {
  rework: "订单返工",
  sourcing: "外发定价&选厂",
  production: "实时生产看板",
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
] as const;

const isReworkCapability = (capability: string): boolean =>
  REWORK_CAPABILITY_PREFIXES.some((prefix) => capability.startsWith(prefix));

export function accessModuleIdsForCapabilities(
  capabilities: readonly string[],
): PlatformAccessModuleId[] {
  const modules = new Set<PlatformAccessModuleId>();
  for (const capability of capabilities) {
    if (capability === "production-reporting") {
      modules.add("production");
    } else if (capability.startsWith("sourcing:")) {
      modules.add("sourcing");
    } else if (isPlatformCapability(capability)) {
      modules.add("platform");
    } else if (isReworkCapability(capability)) {
      modules.add("rework");
    }
  }
  return MODULE_ORDER.filter((moduleId) => modules.has(moduleId));
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
  return [...(PROTECTED_ROLE_MODULES[roleCode] ?? accessModuleIdsForCapabilities(capabilities))];
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

export function todoModuleIdsForUser(user: Readonly<{
  businessRoles?: readonly string[];
  capabilities: readonly string[];
  isRoot?: boolean;
}>): TodoAccessModuleId[] {
  if (user.isRoot) return ["rework", "sourcing", "production"];

  const roles = user.businessRoles ?? [];
  const classified = roles.length > 0
    ? roles.flatMap((roleCode) => accessModuleIdsForRole(roleCode, user.capabilities))
    : accessModuleIdsForCapabilities(user.capabilities);
  const modules = new Set(classified);
  if (user.capabilities.includes("todo:view") && user.capabilities.includes("sourcing:view") && roles.some(role=>["order_merchandiser","production_management","owner_group"].includes(role))) modules.add("production");
  else modules.delete("production");
  return (["rework", "sourcing", "production"] as const).filter((moduleId) => modules.has(moduleId));
}
