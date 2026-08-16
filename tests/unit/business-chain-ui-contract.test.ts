import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("business-chain UI handoff contracts", () => {
  it("inherits N01 quantity and persists a valid N02 plan before personnel assignment", async () => {
    const source = await readFile(
      "apps/web/src/process-configuration-form.tsx",
      "utf8",
    );
    expect(source).toContain("/business-detail");
    expect(source).toContain("emptyItem(loadedDetail.reworkQuantity)");
    expect(source).toContain("validateItemForms");
    expect(source).toContain("const saved = await persistCurrentDraft()");
    expect(source).toContain("expectedOrderVersion: saved.orderVersion");
    expect(source).toContain(
      "expectedConfigurationVersion: savedConfiguration.configurationVersion",
    );
    expect(source).toContain("计划已提交 · 待分配人员");
    expect(source).toContain("确认进入人员分配");
    expect(source).not.toContain("单价（元）");
  });

  it("warns about another same-style order only while that order is unfinished", async () => {
    const [service, form] = await Promise.all([
      readFile("apps/api/src/rework/service.ts", "utf8"),
      readFile("apps/web/src/rework-form.tsx", "utf8"),
    ]);
    expect(service).toContain("other.status NOT IN ('completed','cancelled','deleted')");
    expect(form).toContain("同款号存在其他未完结单；系统仅提示，不会自动合并");
  });

  it("keeps IE review out of N02 and leaves its business detail facts readable", async () => {
    const [form, detail] = await Promise.all([
      readFile("apps/web/src/process-configuration-form.tsx", "utf8"),
      readFile("apps/api/src/rework/rework-business-detail-service.ts", "utf8"),
    ]);
    expect(form).not.toContain("审核通过并生效");
    expect(form).not.toContain("单价（元）");
    expect(form).toContain("只填工序和预估数量");
    expect(detail).toContain("processConfigurationCreatedBy");
    expect(detail).toContain("latest_configuration.created_by");
  });

  it("lets N06 quantity confirmation and IE-review roles reach their actual workflow", async () => {
    const [app, detail, panel] = await Promise.all([
      readFile("apps/web/src/App.tsx", "utf8"),
      readFile("apps/web/src/rework-detail-page.tsx", "utf8"),
      readFile("apps/web/src/whole-order-review-panel.tsx", "utf8"),
    ]);
    expect(app).toContain('{ requiredRole: "order_merchandiser", requiredCapability: "quantity:confirm" }');
    expect(app).toContain('{ requiredRole: "ie_reviewer", requiredCapability: "process:review" }');
    expect(detail).toContain('hasRole(user, "order_merchandiser") && hasCapability(user, "quantity:confirm")');
    expect(detail).toContain('hasRole(user, "ie_reviewer") && hasCapability(user, "process:review")');
    expect(panel).toContain('if (cutInput === null) return');
    expect(panel).toContain('if (returnInput === null) return');
    expect(panel).toContain('if (maximumInput === null) return');
    expect(panel).toContain("待订单跟单确认");
    expect(panel).toContain("待 IE 复核");
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
    expect(detail).toContain('title: "发起与方案"');
    expect(detail).toContain('title: "返工执行"');
    expect(detail).toContain('title: "责任与结算"');
    expect(detail).toContain('node("initiation", "01"');
    expect(detail).toContain('node("process_configuration", "02", "返工计划"');
    expect(detail).toContain('node("task_assignment", "03", "分配返工人员"');
    expect(detail).toContain('node("work_reporting", "04", "完工上数"');
    expect(detail).toContain('node("whole_order_review", "05", "尾部确认数量与单价"');
    expect(detail).toContain('node("responsibility", "07", "责任判定与资料核验"');
    expect(detail).toContain('node("owner_signature", "08", "老板确认签字"');
    expect(detail).toContain('node("settlement_ledger", "09", "责任结算台账"');
    expect(detail).toContain('node("settlement_followup", "10", "订单完成与后续结算"');
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
    expect(workReporting).toContain("搜索返工人员");
    expect(workReporting).toContain("filteredPeople");
    expect(externalResponsibility).toContain("输入供应商名称搜索");
  });

  it("keeps N04 people sourced from worker eligibility and explicit temporary-worker records", async () => {
    const [server, workerAware, migration, app, shell] = await Promise.all([
      readFile("apps/api/src/server.ts", "utf8"),
      readFile("apps/api/src/access/worker-aware-access-service.ts", "utf8"),
      readFile("apps/api/migrations/0038_worker_person_materialization.sql", "utf8"),
      readFile("apps/web/src/App.tsx", "utf8"),
      readFile("apps/web/src/components.tsx", "utf8"),
    ]);
    expect(server).toContain("WorkerAwareAccessMasterDataService");
    expect(server).toContain("employee.businessRoles.includes(\"worker\")");
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

  it("keeps N08 owner signature retry-safe, with only agree and direct reject actions", async () => {
    const source = await readFile("apps/web/src/responsibility-determination-panel.tsx", "utf8");
    expect(source).toContain("pendingMutationKeys");
    expect(source).toContain("responsibility-owner-signature/${decision}");
    expect(source).toContain("确认同意");
    expect(source).toContain("驳回");
    expect(source).not.toContain("驳回原因");
  });
});
