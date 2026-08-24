import type { AuthorizedUser } from "./auth.js";

const has = (user: AuthorizedUser, capability: string): boolean =>
  user.capabilities.includes(capability);
const hasRole = (user: AuthorizedUser, role: string): boolean =>
  user.businessRoles?.includes(role) === true;

export function landingTarget(user: AuthorizedUser): string | null {
  if (
    (hasRole(user, "warehouse_receiver") && has(user, "receiving:create"))
    || (hasRole(user, "worker") && has(user, "work:report"))
    || (hasRole(user, "tail_inspector") && has(user, "tail_inspection:report"))
  ) return "ui/frontline";

  if (has(user, "todo:view")) return "ui/my-tasks";

  if (
    user.isRoot === true
    || hasRole(user, "owner_group")
    || has(user, "dashboard:management:read")
  ) return "ui/management";

  if (hasRole(user, "system_admin") && has(user, "admin:read")) {
    return "ui/admin";
  }

  if (has(user, "dashboard:site:read")) return "ui/supervisor";
  if (hasRole(user, "quality_control") && has(user, "rework:initiate")) {
    return "ui/qc/new";
  }

  if (
    (hasRole(user, "tail_supervisor") && has(user, "process:configure"))
    || (hasRole(user, "ie_reviewer") && has(user, "process:review"))
  ) return "ui/process-configuration";

  if (
    (hasRole(user, "tail_supervisor") && (
      has(user, "work:assign")
      || has(user, "submission:audit")
      || has(user, "quantity:adjust")
    ))
    || (hasRole(user, "worker") && has(user, "work:report"))
    || has(user, "work:report_for_worker")
    || (hasRole(user, "order_merchandiser") && has(user, "quantity:confirm"))
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
