import { canAccessPatternRoom } from "./pattern-room-access.js";
import { canAccessFinance } from "./finance-access.js";
import type { AuthorizedUser } from "./auth.js";
import { landingTarget } from "./landing-target.js";

export const PLATFORM_MODULE_QUERY = "platform_module";

export type PlatformModule = Readonly<{
  id: "rework" | "sourcing" | "suppliers" | "production" | "samples" | "finance" | "pattern_room";
  href: string;
}>;

export function canAccessSourcing(user: AuthorizedUser): boolean {
  return user.isRoot === true
    || user.businessRoles?.includes("owner_group") === true
    || user.capabilities.includes("sourcing:view");
}

export function canAccessSupplierCenter(user: AuthorizedUser): boolean {
  return user.isRoot === true || user.capabilities.includes("supplier_profile:read");
}

export function canAccessSamples(user: AuthorizedUser): boolean {
  return user.isRoot === true || (user.capabilities.includes("sample:view_basic")
    && user.businessRoles?.some(role => ["sample_designer", "sample_administrative", "sample_finance", "finance_director", "finance_read", "owner_group"].includes(role)) === true);
}

export function canAccessProductionReporting(user: AuthorizedUser): boolean {
  return user.isRoot === true
    || (user.businessRoles?.includes("production_reporter") === true && user.capabilities.includes("production-reporting"))
    || (user.businessRoles?.some(role => ["owner_group", "production_management", "order_merchandiser"].includes(role)) === true && user.capabilities.includes("sourcing:view"));
}

export function canAccessProduction(user: AuthorizedUser): boolean {
  return canAccessProductionReporting(user)
    || (user.businessRoles?.some(role => ["finance_director", "finance_read"].includes(role)) === true && user.capabilities.includes("sourcing:view"));
}

export function accessiblePlatformModules(user: AuthorizedUser): readonly PlatformModule[] {
  const modules: PlatformModule[] = [];
  const reworkHref = landingTarget(user);
  if (canAccessSourcing(user)) modules.push({ id: "sourcing", href: "ui/sourcing/pending" });
  if (canAccessSupplierCenter(user)) modules.push({ id: "suppliers", href: "ui/suppliers" });
  if (canAccessProduction(user)) modules.push({ id: "production", href: "ui/production-dashboard" });
  if (canAccessSamples(user)) modules.push({ id: "samples", href: "ui/samples" });
  if (canAccessPatternRoom(user)) modules.push({ id: "pattern_room", href: "ui/pattern-room" });
  if (canAccessFinance(user)) modules.push({ id: "finance", href: "ui/finance" });
  if (reworkHref && reworkHref !== "ui/wages" && reworkHref !== "ui/finance") modules.push({ id: "rework", href: reworkHref });
  return modules;
}

export function platformModuleHref(module: PlatformModule): string {
  if (module.id !== "rework") return module.href;
  const separator = module.href.includes("?") ? "&" : "?";
  return `${module.href}${separator}${PLATFORM_MODULE_QUERY}=rework`;
}

export function shouldRedirectLegacyLandingToPlatformHome(
  _user: AuthorizedUser,
  _path: string,
  _search: string,
  _selectedModule: string | null,
): boolean {
  void _user;
  void _path;
  void _search;
  void _selectedModule;
  return false;
}

export function platformLandingTarget(user: AuthorizedUser): string | null {
  const modules = accessiblePlatformModules(user);
  if (modules.length >= 2) return user.isRoot || user.capabilities.includes("todo:view") ? "ui/my-tasks" : modules[0]?.href ?? null;
  return modules[0]?.href ?? null;
}
