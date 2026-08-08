import type { AuthorizedUser } from "./auth.js";

const has = (user: AuthorizedUser, capability: string): boolean =>
  user.capabilities.includes(capability);

export function landingTarget(user: AuthorizedUser): string | null {
  if (
    user.isRoot === true
    || user.businessRoles?.includes("owner_group") === true
    || has(user, "dashboard:management:read")
  ) return "ui/management";

  if (
    user.businessRoles?.includes("system_admin") === true
    && has(user, "admin:read")
  ) return "ui/admin";

  if (has(user, "dashboard:site:read")) return "ui/supervisor";
  if (has(user, "rework:initiate")) return "ui/qc/new";

  if (has(user, "process:configure") || has(user, "process:review")) {
    return "ui/process-configuration";
  }

  if (
    has(user, "work:assign")
    || has(user, "submission:audit")
    || has(user, "quantity:adjust")
    || has(user, "work:report")
    || has(user, "work:report_for_worker")
    || has(user, "quantity:confirm")
  ) return "ui/work-reporting";

  if (
    has(user, "responsibility:determine")
    || has(user, "responsibility:takeover")
    || has(user, "responsibility:confirm_high_multiplier")
  ) return "ui/responsibility";

  if (has(user, "own_factory:view")) return "ui/own-factory-approvals";
  if (has(user, "external_responsibility:view")) return "ui/external-responsibilities";
  if (has(user, "wage:view")) return "ui/wages";
  if (has(user, "master_data:manage")) return "ui/master-data";
  if (has(user, "report:view")) return "ui/reports";

  return null;
}
