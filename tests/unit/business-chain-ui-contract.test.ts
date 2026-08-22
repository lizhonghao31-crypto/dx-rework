import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("business-chain UI handoff contracts", () => {
  it("persists N02 processes, candidate prices and workers before IE review, without estimating quantity", async () => {
    const source = await readFile(
      "apps/web/src/process-worker-assignment-form.tsx",
      "utf8",
    );
    expect(source).toContain("/business-detail");
    expect(source).toContain("validateItems");
    expect(source).toContain("const saved = await persistMergedDraft()");
    expect(source).toContain("expectedOrderVersion: saved.orderVersion");
    expect(source).toContain(
      "expectedConfigurationVersion: savedConfiguration.configurationVersion",
    );
    expect(source).toContain("process-worker-plan");
    expect(source).toContain("已提交 IE 核价");
    expect(source).toContain("确认提交当前工序、候选单价和预分配工人给 IE 核价");
    expect(source).toContain("候选单价（元/件）");
    expect(source).toContain("plannedQuantity: 1");
  });

  it("warns about another same-style order only while that order is unfinished", async () => {
    const [service, form] = await Promise.all([
      readFile("apps/api/src/rework/service.ts", "utf8"),
      readFile("apps/web/src/rework-v2-form.tsx", "utf8"),
    ]);
    expect(service).toContain("other.status NOT IN ('completed','cancelled','deleted')");
    expect(form).toContain("同款号存在其他未完结单；系统仅提示，不会自动合并");
  });

  it("keeps IE review as the explicit N03 gate and leaves its business detail facts readable", async () => {
    const [form, detail] = await Promise.all([
      readFile("apps/web/src/process-worker-assignment-form.tsx", "utf8"),
      readFile("apps/api/src/rework/rework-business-detail-service.ts", "utf8"),
    ]);
    expect(form).toContain("核价通过");
    expect(form).toContain("候选单价（元/件）");
    expect(form).toContain("工序、单价与预分配人员");
    expect(form).toContain("人员已经由尾部主管预分配；IE 只核准工序与单价，不修改分工。");
    expect(detail).toContain("processConfigurationCreatedBy");
    expect(detail).toContain("latest_configuration.created_by");
  });

  it("lets tail inspectors and IE-review roles reach their actual workflow", async () => {
    const [detail, reporting] = await Promise.all([
      readFile("apps/web/src/rework-detail-page.tsx", "utf8"),
      readFile("apps/web/src/work-reporting-form.tsx", "utf8"),
    ]);
    expect(detail).toContain('hasRole(user, "tail_inspector") && hasCapability(user, "tail_inspection:report")');
    expect(detail).toContain('hasRole(user, "ie_reviewer") && hasCapability(user, "process:review")');
    expect(reporting).toContain('task.executionKind === "tail_inspection"');
    expect(reporting).toContain("尾查完成&报数");
  });

  it("keeps responsibility party facts valid while the primary UI records the current actor automatically", async () => {
    const [panel, service, routes] = await Promise.all([
      readFile("apps/web/src/responsibility-determination-panel.tsx", "utf8"),
      readFile("apps/api/src/rework/responsibility-determination-application-service.ts", "utf8"),
      readFile("apps/api/src/rework/responsibility-determination-routes.ts", "utf8"),
    ]);
    expect(panel).toContain("allocation.shareBps > 0n");
    expect(panel).toContain("if (shareTotalBps(process.allocations) !== 10000n) return false;");
    expect(panel).toContain('multiplier >= 1200n && allocation.supplierId.length > 0');
    expect(panel).toContain('supplierId: allocation.supplierId || undefined');
    expect(panel).toContain("requestCurrentUserId");
    expect(panel).toContain('const handlerUserId = response?.handlerUserId ?? currentUserId');
    expect(panel).not.toContain("ResponsibilityTransferOptionsResponseSchema");
    expect(panel).not.toContain("新的责任处理人");
    expect(panel).not.toContain("转交责任处理");
    expect(panel).not.toContain('label="目标用户 UUID"');
    expect(service).toContain("responsibility_can_determine(u.id,$2)");
    expect(routes).toContain("responsibility-determinations/transfer-options");
  });

  it("keeps the merged eight-node workflow reachable from permitted primary entries", async () => {
    const [app, shell, detail] = await Promise.all([
      readFile("apps/web/src/App.tsx", "utf8"),
      readFile("apps/web/src/components.tsx", "utf8"),
      readFile("apps/web/src/rework-detail-page.tsx", "utf8"),
    ]);
    expect(app).toContain('<Shell active="返工单看板" mobileNavigation="transaction"><ProcessConfigurationForm /></Shell>');
    expect(app).toContain('<Shell active="返工单看板" mobileNavigation="transaction"><WorkReportingForm /></Shell>');
    expect(app).toContain('<Shell active="工资管理"><WagePage path={path} /></Shell>');
    for (const label of ["我的待办", "订单看板", "发起返工", "返工单看板", "系统管理", "财务报表", "工资管理"]) {
      expect(shell).toContain(`name: "${label}"`);
    }
    expect(shell).not.toContain('name: "返工上数"');
    expect(shell).not.toContain("flow-navigation__arrow");
    expect(detail).toContain('title: "发起、配置与核价"');
    expect(detail).toContain('title: "返工执行"');
    expect(detail).toContain('title: "责任与结算"');
    expect(detail).toContain('node("initiation", "01"');
    expect(detail).toContain('node("process_configuration", "02", "分配工序 &工人"');
    expect(detail).toContain('node("ie_review", "03", "IE 核价"');
    expect(detail).toContain('node("work_reporting", "04", "返工执行报数"');
    expect(detail).not.toContain('node("tail_inspection"');
    expect(detail).toContain('node("whole_order_review", "05", "尾部主管整单确认"');
    expect(detail).toContain('node("responsibility", "06", "责任判定"');
    expect(detail).toContain('node("owner_signature", "07", "老板确认签字"');
    expect(detail).toContain('node("settlement_followup", "08", "返工业务完成"');
    expect(detail).not.toContain('node("task_assignment", "04", "分配返工人员"');
    expect(detail).toContain('pending_task_assignment: "process_configuration"');
    expect(detail).toContain('if (value === "task_assignment") return "process_configuration";');
    const workflowKeys = [
      "initiation",
      "process_configuration",
      "ie_review",
      "work_reporting",
      "whole_order_review",
      "responsibility",
      "owner_signature",
      "settlement_followup",
    ];
    const workflowNodePositions = workflowKeys.map((key, index) =>
      detail.indexOf(`node("${key}", "${String(index + 1).padStart(2, "0")}"`),
    );
    expect(workflowNodePositions).toHaveLength(8);
    expect(workflowNodePositions.every((position) => position >= 0)).toBe(true);
    expect(workflowNodePositions).toEqual([...workflowNodePositions].sort((left, right) => left - right));
  });

  it("routes the removed collective mock URL into the real execution workflow with the same authorization", async () => {
    const app = await readFile("apps/web/src/App.tsx", "utf8");
    expect(app).toContain('path === "/ui/work-reporting" || path === "/ui/piecework/collective"');
    expect(app).toContain('<Shell active="返工单看板" mobileNavigation="transaction"><WorkReportingForm /></Shell>');
    expect(app).not.toContain("<MobileForm piecework />");
  });

  it("keeps high-frequency business selectors searchable with a visible N02 worker-search boundary", async () => {
    const [initiation, processConfiguration, processConfigurationCss, workReporting, externalResponsibility] = await Promise.all([
      readFile("apps/web/src/rework-v2-form.tsx", "utf8"),
      readFile("apps/web/src/process-worker-assignment-form.tsx", "utf8"),
      readFile("apps/web/src/process-worker-assignment-form.css", "utf8"),
      readFile("apps/web/src/work-reporting-form.tsx", "utf8"),
      readFile("apps/web/src/external-responsibility-panel.tsx", "utf8"),
    ]);
    expect(initiation).toContain("<SearchSelect");
    expect(initiation).toContain('placeholder="搜索订单跟单"');
    expect(initiation).toContain("<FactorySearch");
    expect(processConfiguration).toContain('placeholder="搜索工序"');
    expect(processConfiguration).toContain("<SearchSelect");
    expect(processConfiguration).toContain("processOptions.map");
    expect(processConfigurationCss).toContain(".process-worker-picker>.search-select input");
    expect(processConfigurationCss).toContain("border:1px solid var(--dx-v2-color-border)");
    expect(processConfiguration).toContain("已分配人员");
    expect(processConfiguration).toContain('{ label: "正式工"');
    expect(processConfiguration).toContain('{ label: "临时工"');
    expect(processConfiguration).toContain("plan?.assignments");
    expect(processConfiguration).toContain("process-worker-line__body");
    expect(processConfigurationCss).toContain("grid-template-columns:minmax(220px,.56fr) minmax(560px,1.44fr)");
    expect(processConfiguration).toContain("parseWorkTaskOptions");
    expect(processConfiguration).toContain("optionLoadIssue");
    expect(processConfiguration).toContain("人员目录暂不可用");
    expect(processConfigurationCss).toContain(".process-worker-people-groups");
    expect(workReporting).toContain('peopleType === "internal" ? "正式工" : "临时工"');
    expect(workReporting).toContain("filteredPeople");
    expect(externalResponsibility).toContain("输入供应商名称搜索");
  });

  it("keeps legacy assignment people sourced from worker eligibility and explicit temporary-worker records", async () => {
    const [server, workerAware, workReportingRoutes, workReportingService, migration, app, shell] = await Promise.all([
      readFile("apps/api/src/server.ts", "utf8"),
      readFile("apps/api/src/access/worker-aware-access-service.ts", "utf8"),
      readFile("apps/api/src/rework/work-reporting-routes.ts", "utf8"),
      readFile("apps/api/src/rework/work-reporting-service.ts", "utf8"),
      readFile("apps/api/migrations/0038_worker_person_materialization.sql", "utf8"),
      readFile("apps/web/src/App.tsx", "utf8"),
      readFile("apps/web/src/components.tsx", "utf8"),
    ]);
    expect(server).toContain("WorkerAwareAccessMasterDataService");
    expect(server).not.toContain("listAssignablePeople: async");
    expect(workReportingRoutes).toContain("dependencies.service.listAssignablePeople(assignActor)");
    expect(workReportingService).toContain("JOIN app_users app_user");
    expect(workReportingService).toContain("identity.active=true");
    expect(workReportingService).toContain("assignment.role_code='worker'");
    expect(workerAware).toContain('["worker", "tail_inspector"]');
    expect(workerAware).toContain("await this.createPerson");
    expect(workerAware).toContain("await super.revokeRole");
    expect(migration).toContain("rework_work_task_members_employee_eligibility");
    expect(migration).toContain("assignment.role_code='worker'");
    expect(app).toContain('path === "/ui/people"');
    expect(shell).toContain('name: "系统管理"');
    expect(shell).toContain('href: "/ui/admin"');
  });

  it("prevalidates the simple supplier deduction and auto-closes when cumulative deduction reaches the target", async () => {
    const source = await readFile(
      "apps/web/src/external-responsibility-panel.tsx",
      "utf8",
    );
    expect(source).toContain("本次扣款金额必须大于 0，最多两位小数");
    expect(source).toContain("本次扣款金额不能超过当前剩余应扣金额");
    expect(source).toContain('recorded.remainingAmount === "0.00" && recorded.canClose');
    expect(source).toContain("await closeFull(recorded)");
    expect(source).toContain("<ExternalEvidenceUploader");
    expect(source).toContain("重判责任");
    expect(source).not.toContain("按部分关闭");
    expect(source).not.toContain("登记未扣成功");
  });

  it("keeps responsibility and external-settlement queues linked to the actual order detail", async () => {
    const [responsibilityQueue, ownFactoryQueue, externalQueue] = await Promise.all([
      readFile("apps/web/src/responsibility-queue-page.tsx", "utf8"),
      readFile("apps/web/src/own-factory-approval-queue-page.tsx", "utf8"),
      readFile("apps/web/src/external-responsibility-queue-page.tsx", "utf8"),
    ]);
    for (const source of [responsibilityQueue, ownFactoryQueue, externalQueue]) {
      expect(source).toContain('href={`${basePath}/ui/tasks/${item.reworkOrderId}`}');
    }
    expect(responsibilityQueue).not.toContain('actionHref="/ui/tasks"');
    expect(ownFactoryQueue).not.toContain('actionHref="/ui/responsibility"');
    expect(externalQueue).not.toContain('actionHref="/ui/responsibility"');
  });

  it("keeps N08 owner signature retry-safe, with only agree and direct reject actions", async () => {
    const source = await readFile("apps/web/src/responsibility-determination-panel.tsx", "utf8");
    expect(source).toContain("pendingMutationKeys");
    expect(source).toContain("responsibility-owner-signature/${decision}");
    expect(source).toContain("确认同意");
    expect(source).toContain("驳回");
    expect(source).not.toContain("驳回原因");
  });
});
