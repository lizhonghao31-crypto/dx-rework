import type { AuthorizedUser } from "./auth.js";

const has = (user: AuthorizedUser, capability: string): boolean =>
  user.capabilities.includes(capability);
const hasRole = (user: AuthorizedUser, role: string): boolean =>
  user.businessRoles?.includes(role) === true;

const FRONTLINE_ROLES = new Set(["warehouse_receiver", "worker", "tail_inspector"]);

const hasStandardWorkspaceRole = (user: AuthorizedUser): boolean =>
  user.businessRoles?.some((role) => !FRONTLINE_ROLES.has(role)) === true;

function frontlineTargets(user: AuthorizedUser): readonly string[] {
  const targets: string[] = [];

  if (hasRole(user, "warehouse_receiver") && has(user, "receiving:create")) {
    targets.push("ui/receiving");
  }
  if (hasRole(user, "worker") && has(user, "work:report")) {
    targets.push("ui/frontline/tasks?kind=worker");
  }
  if (hasRole(user, "tail_inspector") && has(user, "tail_inspection:report")) {
    targets.push("ui/frontline/tasks?kind=tail_inspection");
  }

  return targets;
}

export function frontlineLandingTarget(user: AuthorizedUser): string | null {
  const targets = frontlineTargets(user);
  if (targets.length === 1) return targets[0] ?? null;
  if (targets.length > 1) return "ui/frontline";
  return null;
}

export function landingTarget(user: AuthorizedUser): string | null {
  if (user.isRoot === true) return "ui/my-tasks";
  if (hasStandardWorkspaceRole(user) && has(user, "todo:view")) return "ui/my-tasks";

  const frontlineTarget = frontlineLandingTarget(user);
  if (frontlineTarget) return frontlineTarget;

  if (has(user, "todo:view")) return "ui/my-tasks";

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
