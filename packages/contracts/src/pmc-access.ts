/** Approved read parity with production_management, frozen independently of its writes. */
export const PMC_ROLE = "pmc";
export const PMC_READ_CAPABILITIES = [
  "cutting:orders:view", "dashboard:management:read", "external_responsibility:view", "own_factory:view",
  "pattern_room:catalog:read", "pattern_room:misc:quote", "pattern_room:orders:view", "pattern_room:prices:read",
  "people:read", "process_catalog:read", "receiving:export", "report:export", "report:view", "sourcing:view",
  "supplier_catalog:read", "supplier_contract_data:read", "supplier_profile:read", "todo:view", "wage:export", "wage:view",
  "tools:read", "supplier_onboarding:read", "todo:routing_exception_read",
] as const;

export function isPmcOnly(roles: readonly string[]): boolean {
  return roles.length > 0 && roles.every(role => role === PMC_ROLE);
}

export function pmcEffectiveCapabilities(roles: readonly string[], capabilities: readonly string[], isRoot = false): string[] {
  return capabilities.filter(capability => isRoot || !isPmcOnly(roles)
    || (PMC_READ_CAPABILITIES as readonly string[]).includes(capability));
}
