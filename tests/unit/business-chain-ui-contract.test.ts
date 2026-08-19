import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("business-chain UI handoff contracts", () => {
  it("persists N02 processes and candidate prices before IE review, without estimating quantity", async () => {
    const source = await readFile(
      "apps/web/src/process-configuration-form.tsx",
      "utf8",
    );
    expect(source).toContain("/business-detail");
    expect(source).toContain("validateItemForms");
    expect(source).toContain("const saved = await persistCurrentDraft()");
    expect(source).toContain("expectedOrderVersion: saved.orderVersion");
    expect(source).toContain(
      "expectedConfigurationVersion: savedConfiguration.configurationVersion",
    );
    expect(source).toContain("已提交 IE 审核");
    expect(source).toContain("确认提交当前工序与候选单价给 IE 核价，并立即分配尾查");
    expect(source).toContain("候选单价（元 / 件）");
    expect(source).toContain("plannedQuantity: 1");
  });

  it("warns about another same-style order only while that order is unfinished", async () => {
    const [service, form] = await Promise.all([
      readFile("apps/api/src/rework/service.ts", "utf8"),
      readFile("apps/web/src/rework-form.tsx", "utf8"),
    ]);
    expect(service).toContain("other.status NOT IN ('completed','cancelled','deleted')");
    expect(form).toContain("同款号存在其他未完结单；系统仅提示，不会自动合并");
  });

  it("keeps IE review as the explicit N03 gate and leaves its business detail facts readable", async () => {
    const [form, detail] = await Promise.all([
      readFile("apps/web/src/process-configuration-form.tsx", "utf8"),
      readFile("apps/api/src/rework/rework-business-detail-service.ts", "utf8"),
    ]);
    expect(form).toContain("审核通过并生效");
    expect(form).toContain("候选单价（元 / 件）");
    expect(form).toContain("工序与候选单价");
    expect(detail).toContain("processConfigurationCreatedBy");
    expect(detail).toContain("latest_configuration.created_by");
  });

  it("lets tail inspectors and IE-review roles reach their actual workflow", async () => {
    const [detail, tailPanel] = await Promise.all([
      readFile("apps/web/src/rework-detail-page.tsx", "utf8"),
      readFile("apps/web/src/tail-inspection-panel.tsx", "utf8"),
    ]);
    expect(detail).toContain('hasRole(user, "tail_inspector") && hasCapability(user, "tail_inspection:report")');
    expect(detail).toContain('hasRole(user, "ie_reviewer") && hasCapability(user, "process:review")');
    expect(tailPanel).toContain("返件总数（件）");
    expect(tailPanel).toContain("提交尾查报数");
  });

  it("keeps N07 party facts valid, supplier-owned and transfer targets human-readable", async () => {
    const [panel, service, routes] = await Promise.all([
      readFile("apps/web/src/responsibility-determination-panel.tsx", "utf8"),
      readFile("apps/api/src/rework/responsibility-determination-application-service.ts", "utf8"),
      readFile("apps/api/src/rework/responsibility-determination-routes.ts", "utf8"),
    ]);
    expect(panel).toContain("allocation.shareBps > 0n");
    expect(panel).toContain("if (shareTotalBps(process.allocations) !== 10000n) return false;");
    expect(panel).toContain('multiplier >= 1200n && allocation.supplierId.length > 0');
    expect(panel).toContain('supplierId: allocation.supplierId || undefined');
    expect(panel).toContain("输入姓名搜索");
    expect(panel).toContain("ResponsibilityTransferOptionsResponseSchema");
    expect(panel).not.toContain('label="目标用户 UUID"');
    expect(service).toContain("responsibility_can_determine(u.id,$2)");
    expect(service).toContain("只有当前有效责任处理人可以查看转交对象");
    expect(routes).toContain("responsibility-determinations/transfer-options");
  });

  it("keeps process, execution, wage work and the N07–N10 workflow reachable from permitted primary entries", async () => {
    const [app, shell, detail] = await Promise.all([
      readFile("apps/web/src/App.tsx", "utf8"),
      readFile("apps/web/src/components.tsx", "utf8"),
      readFile("apps/web/src/rework-detail-page.tsx", "utf8"),
    ]);
    expect(app).toContain('<Shell active="全部订单" mobileNavigation="transaction"><ProcessConfigurationForm /></Shell>');
    expect(app).toContain('<Shell active="全部订单" mobileNavigation="transaction"><WorkReportingForm /></Shell>');
    expect(app).toContain('<Shell active="工资管理"><WagePage path={path} /></Shell>');
    for (const label of ["我的待办", "发起返工", "全部订单", "系统管理", "财务报表", "工资管理"]) {
      expect(shell).toContain(`name: "${label}"`);
    }
    expect(shell).not.toContain('name: "返工上数"');
    expect(shell).not.toContain("flow-navigation__arrow");
    expect(detail).toContain('title: "发起、配置与核价"');
    expect(detail).toContain('title: "分工与返工执行"');
    expect(detail).toContain('title: "责任与结算"');
    expect(detail).toContain('node("initiation", "01"');
    expect(detail).toContain('node("process_configuration", "02", "工序与候选单价"');
    expect(detail).toContain('node("ie_review", "03", "IE 核价"');
    expect(detail).toContain('node("task_assignment", "04", "分配返工人员"');
    expect(detail).toContain('node("work_reporting", "05", "工人完工上数"');
    expect(detail).toContain('node("tail_inspection", "06", "尾查报数"');
    expect(detail).toContain('node("whole_order_review", "07", "尾部主管整单确认"');
    expect(detail).toContain('node("responsibility", "08", "责任判定"');
    expect(detail).toContain('node("owner_signature", "09", "老板确认签字"');
    expect(detail).toContain('node("settlement_followup", "10", "返工业务完成"');
    const workflowNodePositions = Array.from({ length: 10 }, (_, index) =>
      detail.indexOf(`node("${[
        "initiation",
        "process_configuration",
        "ie_review",
        "task_assignment",
        "work_reporting",
        "tail_inspection",
        "whole_order_review",
        "responsibility",
        "owner_signature",
        "settlement_followup",
      ][index]}", "${String(index + 1).padStart(2, "0")}"`),
    );
    expect(workflowNodePositions.every((position) => position >= 0)).toBe(true);
    expect(workflowNodePositions).toEqual([...workflowNodePositions].sort((left, right) => left - right));
  });

  it("routes the removed collective mock URL into the real N04-N06 workflow with the same authorization", async () => {
    const app = await readFile("apps/web/src/App.tsx", "utf8");
    expect(app).toContain('path === "/ui/work-reporting" || path === "/ui/piecework/collective"');
    expect(app).toContain('<Shell active="全部订单" mobileNavigation="transaction"><WorkReportingForm /></Shell>');
    expect(app).not.toContain("<MobileForm piecework />");
  });

  it("keeps high-frequency business selectors searchable without exposing internal IDs", async () => {
    const [initiation, processConfiguration, workReporting, externalResponsibility] = await Promise.all([
      readFile("apps/web/src/rework-form.tsx", "utf8"),
      readFile("apps/web/src/process-configuration-form.tsx", "utf8"),
      readFile("apps/web/src/work-reporting-form.tsx", "utf8"),
      readFile("apps/web/src/external-responsibility-panel.tsx", "utf8"),
    ]);
    expect(initiation).toContain("<SearchSelect");
    expect(initiation).toContain("输入姓名搜索订单跟单");
    expect(initiation).toContain("<FactorySearch");
    expect(processConfiguration).toContain("输入工序名称搜索");
    expect(processConfiguration).toContain("selectCatalogProcess");
    expect(workReporting).toContain('peopleType === "internal" ? "正式工" : "临时工"');
    expect(workReporting).toContain("filteredPeople");
    expect(externalResponsibility).toContain("输入供应商名称搜索");
  });

  it("keeps N04 people sourced from worker eligibility and explicit temporary-worker records", async () => {
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
    expect(workerAware).toContain('input.roleCode !== "worker"');
    expect(workerAware).toContain("await this.createPerson");
    expect(workerAware).toContain("await super.revokeRole");
    expect(migration).toContain("rework_work_task_members_employee_eligibility");
    expect(migration).toContain("assignment.role_code='worker'");
    expect(app).toContain('path === "/ui/people"');
    expect(shell).toContain('name: "系统管理"');
    expect(shell).toContain('href: "/ui/admin"');
  });

  it("prevalidates N11 supplier deduction and unresolved-difference closure inputs", async () => {
    const source = await readFile(
      "apps/web/src/external-responsibility-panel.tsx",
      "utf8",
    );
    expect(source).toContain("请先填写大于 0、最多两位小数的实际扣款金额");
    expect(source).toContain("部分扣款或未扣成功关闭必须先上传扣款结果证据");
    expect(source).toContain("部分扣款或未扣成功关闭必须填写剩余差额最终处理方式");
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

  it("keeps N09 owner signature retry-safe, with only agree and direct reject actions", async () => {
    const source = await readFile("apps/web/src/responsibility-determination-panel.tsx", "utf8");
    expect(source).toContain("pendingMutationKeys");
    expect(source).toContain("responsibility-owner-signature/${decision}");
    expect(source).toContain("确认同意");
    expect(source).toContain("驳回");
    expect(source).not.toContain("驳回原因");
  });
});
