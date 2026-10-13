import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  hasPageAccess,
  type AuthorizedUser,
} from "../../apps/web/src/auth.js";
import { landingTarget } from "../../apps/web/src/landing-target.js";

const zeroRoleRoot: AuthorizedUser = {
  displayName: "Root",
  capabilities: [],
  businessRoles: [],
  isRoot: true,
};

describe("zero-role Root UI entry contract", () => {
  it("lets Root enter any page requirement without an ordinary business role", () => {
    expect(hasPageAccess(zeroRoleRoot)).toBe(true);
    expect(hasPageAccess(zeroRoleRoot, {
      requiredRole: "owner_group",
      requiredCapability: "access:admin",
    })).toBe(true);
    expect(hasPageAccess(zeroRoleRoot, {
      requiredRole: "worker",
      requiredCapability: "work:report",
    })).toBe(true);
    expect(hasPageAccess(zeroRoleRoot, {
      requiredRole: "warehouse_receiver",
      requiredCapability: "receiving:create",
    })).toBe(true);
  });

  it("lands a zero-role Root on my tasks", () => {
    expect(landingTarget(zeroRoleRoot)).toBe("ui/my-tasks");
  });

  it("keeps /auth/me Root-aware instead of deriving access only from role capabilities", async () => {
    const source = await readFile(
      new URL("../../apps/api/src/auth/routes.ts", import.meta.url),
      "utf8",
    );

    expect(source).toContain("const isRoot = options.isRootUser ? await options.isRootUser(user.id) : false;");
    expect(source).toContain('status: user.capabilities.length || isRoot ? "authorized" : "no_role"');
  });

  it("reuses a verified session across route gates and keeps sidebar identity at the bottom", async () => {
    const [auth, session, styles] = await Promise.all([
      readFile(new URL("../../apps/web/src/auth.tsx", import.meta.url), "utf8"),
      readFile(new URL("../../apps/web/src/auth-session.ts", import.meta.url), "utf8"),
      readFile(new URL("../../apps/web/src/styles.css", import.meta.url), "utf8"),
    ]);
    expect(session).toContain("let verifiedResult: SessionVerificationResult | undefined;");
    expect(session).toContain("let sessionVerification: Promise<SessionVerificationResult> | undefined;");
    expect(session).toContain("export function verifySession(force = false): Promise<VerifiedSession>");
    expect(auth).toContain('export { verifySession, verifySessionResult } from "./auth-session.js";');
    expect(auth).toContain('useState<AuthGateState>(() => cachedVerifiedSession() ?? "loading")');
    expect(styles).toContain("display: flex; flex-direction: column;");
    expect(styles).toContain(".app-shell__identity { margin-top: auto;");
  });

  it("keeps Root eligible for privileged primary entries without restoring legacy workflow menus", async () => {
    const source = await readFile(
      new URL("../../apps/web/src/components.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain("const isRoot = currentUser?.isRoot === true;");
    expect(source).not.toContain("const initiationAccess =");
    expect(source).toContain("const reportAccess = isRoot || isOwner");
    expect(source).toContain("const systemManagementAccess = isRoot");
    expect(source).toContain("|| auditAccess");
    expect(source).toContain("|| technicalAdminAccess");
    expect(source).toContain('|| (!isOwner && hasCapability("master_data:manage"));');
    expect(source).toContain('const auditAccess = isRoot || (isSystemAdmin && hasCapability("audit:read"));');
    for (const entry of ["订单回货", "返工单看板", "系统管理", "财务报表", "财务中心"]) {
      expect(source).toContain(`name: "${entry}"`);
    }
    expect(source).not.toContain('name: "发起返工"');
    expect(source).not.toContain('name: "返工上数"');
    expect(source).not.toContain('step: "');
    expect(source).not.toContain('...(isRoot ? ["超级用户"] : [])');
  });

  it("keeps Root on the N00-to-N01 v2 path without an ordinary QC assignment", async () => {
    const [board, routes, supplyRoutes, submission] = await Promise.all([
      readFile(new URL("../../apps/web/src/order-board-page.tsx", import.meta.url), "utf8"),
      readFile(new URL("../../apps/api/src/rework/routes.ts", import.meta.url), "utf8"),
      readFile(new URL("../../apps/api/src/rework/supply-context-routes.ts", import.meta.url), "utf8"),
      readFile(new URL("../../apps/api/src/rework/v2-submission-service.ts", import.meta.url), "utf8"),
    ]);

    expect(board).toContain('setCanInitiate(moduleCanWrite(session.user, "rework") && (isRoot || roles.includes("owner_group") || qualityControl))');
    expect(board).toContain('pageUrl("ui/qc/new")');
    expect(routes).toContain('actorRoles.push("root_superuser")');
    expect(routes).toContain('actorRoles.push("quality_control")');
    expect(routes).toContain('authorizationCapabilities.push("rework:initiate")');
    expect(supplyRoutes).toContain('actorRoles.push("root_superuser")');
    expect(supplyRoutes).toContain('actorRoles.push("quality_control")');
    expect(submission).toContain('actor.actorRoles.includes("root_superuser")');
    expect(submission).toContain('const expectedUploader = actor.actorRoles.includes("root_superuser") ? null : actor.actorId;');
    expect(submission).toContain('($2::uuid IS NULL OR uploaded_by=$2)');
  });

  it("does not mask Root workflow actions behind ordinary-role-only UI gates", async () => {
    const [process, work, tail, review, responsibility, external, detail] = await Promise.all([
      readFile(new URL("../../apps/web/src/process-worker-assignment-form.tsx", import.meta.url), "utf8"),
      readFile(new URL("../../apps/web/src/work-reporting-form.tsx", import.meta.url), "utf8"),
      readFile(new URL("../../apps/web/src/tail-inspection-panel.tsx", import.meta.url), "utf8"),
      readFile(new URL("../../apps/web/src/whole-order-review-panel.tsx", import.meta.url), "utf8"),
      readFile(new URL("../../apps/web/src/responsibility-determination-panel.tsx", import.meta.url), "utf8"),
      readFile(new URL("../../apps/web/src/external-responsibility-panel.tsx", import.meta.url), "utf8"),
      readFile(new URL("../../apps/web/src/rework-detail-page.tsx", import.meta.url), "utf8"),
    ]);

    expect(process).toContain("user?.isRoot === true");
    expect(work).toContain("const reportableTasks = isRoot ? pendingTasks : canAssign ? temporaryTasks : pendingTasks;");
    expect(work).toContain('isRoot ? "代为报数"');
    expect(tail).toContain('isRoot ? "可代报"');
    expect(work).toContain('task.executionKind === "tail_inspection"');
    expect(detail).toContain("const canUseWorkWorkspace");
    expect(detail).toContain("const elevated =");
    expect(review).toContain("data.canReview");
    expect(review).toContain("data.processes.every((process) => process.complete)");
    expect(review).not.toContain("data.canSubmitTailPricing");
    expect(responsibility).toContain("response.canDetermine");
    expect(responsibility).toContain("response?.canOwnerSign");
    expect(external).toContain("caseItem.canRecordDeduction");
    expect(external).toContain("caseItem.canClose");
  });
});