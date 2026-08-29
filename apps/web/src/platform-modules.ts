import type { AuthorizedUser } from "./auth.js";
import { landingTarget } from "./landing-target.js";

export const PLATFORM_MODULE_QUERY = "platform_module";

export type PlatformModule = Readonly<{
  id: "rework" | "sourcing";
  href: string;
}>;

export function canAccessSourcing(user: AuthorizedUser): boolean {
  return user.isRoot === true
    || user.businessRoles?.includes("owner_group") === true
    || user.capabilities.includes("sourcing:view");
}

export function accessiblePlatformModules(user: AuthorizedUser): readonly PlatformModule[] {
  const modules: PlatformModule[] = [];
  const reworkHref = landingTarget(user);
  if (canAccessSourcing(user)) modules.push({ id: "sourcing", href: "ui/sourcing/pending" });
  if (reworkHref) modules.push({ id: "rework", href: reworkHref });
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
  return false;
}

export function platformLandingTarget(user: AuthorizedUser): string | null {
  const modules = accessiblePlatformModules(user);
  if (modules.length >= 2) return user.isRoot || user.capabilities.includes("todo:view") ? "ui/my-tasks" : modules[0]?.href ?? null;
  return modules[0]?.href ?? null;
}
