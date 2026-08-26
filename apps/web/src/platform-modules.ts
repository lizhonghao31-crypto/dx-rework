import type { AuthorizedUser } from "./auth.js";
import { landingTarget } from "./landing-target.js";

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

export function platformLandingTarget(user: AuthorizedUser): string | null {
  const modules = accessiblePlatformModules(user);
  if (modules.length >= 2) return "ui/home";
  return modules[0]?.href ?? null;
}
