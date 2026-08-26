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
  if (canAccessSourcing(user)) modules.push({ id: "sourcing", href: "ui/sourcing" });
  if (reworkHref) modules.push({ id: "rework", href: reworkHref });
  return modules;
}

export function platformModuleHref(module: PlatformModule): string {
  if (module.id !== "rework") return module.href;
  const separator = module.href.includes("?") ? "&" : "?";
  return `${module.href}${separator}${PLATFORM_MODULE_QUERY}=rework`;
}

export function shouldRedirectLegacyLandingToPlatformHome(
  user: AuthorizedUser,
  path: string,
  search: string,
  selectedModule: string | null,
): boolean {
  const query = new URLSearchParams(search);
  if (selectedModule === "rework" || query.get(PLATFORM_MODULE_QUERY) === "rework") return false;
  if (accessiblePlatformModules(user).length < 2) return false;

  const target = landingTarget(user);
  if (!target) return false;

  const targetUrl = new URL(target, "https://dx-rework.local/");
  const currentPath = path.replace(/^\//, "");
  const targetPath = targetUrl.pathname.replace(/^\//, "");
  if (currentPath !== targetPath) return false;

  return [...targetUrl.searchParams.entries()]
    .every(([key, value]) => query.get(key) === value);
}

export function platformLandingTarget(user: AuthorizedUser): string | null {
  const modules = accessiblePlatformModules(user);
  if (modules.length >= 2) return "ui/home";
  return modules[0]?.href ?? null;
}
