export type PlatformAccessModuleId = "rework" | "sourcing" | "platform";

export type PlatformRoleAccess = Readonly<{
  roleCode: string;
  capabilities: readonly string[];
}>;

const MODULE_ORDER: readonly PlatformAccessModuleId[] = ["rework", "sourcing", "platform"];

export const PLATFORM_ACCESS_MODULE_LABELS: Record<PlatformAccessModuleId, string> = {
  rework: "返工",
  sourcing: "报价&选厂",
  platform: "平台管理",
};

const isPlatformCapability = (capability: string): boolean =>
  capability.startsWith("access:")
  || capability.startsWith("admin:")
  || capability.startsWith("audit:")
  || capability.startsWith("master_data:");

export function accessModuleIdsForCapabilities(
  capabilities: readonly string[],
): PlatformAccessModuleId[] {
  const modules = new Set<PlatformAccessModuleId>();
  for (const capability of capabilities) {
    if (capability.startsWith("sourcing:")) {
      modules.add("sourcing");
    } else if (isPlatformCapability(capability)) {
      modules.add("platform");
    } else {
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

export function employeeHasAccessModule(
  businessRoles: readonly string[],
  roles: readonly PlatformRoleAccess[],
  moduleId: PlatformAccessModuleId,
): boolean {
  const roleCodes = new Set(businessRoles);
  return roles.some((role) =>
    roleCodes.has(role.roleCode)
    && accessModuleIdsForCapabilities(role.capabilities).includes(moduleId));
}
