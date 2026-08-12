import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("business-chain UI handoff contracts", () => {
  it("inherits N01 quantity and persists a valid N02 draft before IE submit", async () => {
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
    expect(source).toContain("待当前有效 IE 审核");
    expect(source).not.toContain("待郎飞 IE 审核");
  });

  it("warns about another same-style order only while that order is unfinished", async () => {
    const [service, form] = await Promise.all([
      readFile("apps/api/src/rework/service.ts", "utf8"),
      readFile("apps/web/src/rework-form.tsx", "utf8"),
    ]);
    expect(service).toContain("other.status NOT IN ('completed','cancelled','deleted')");
    expect(form).toContain("同款号存在其他未完结单；系统仅提示，不会自动合并");
  });

  it("explains N03 self-review separation before the user sends a doomed request", async () => {
    const [form, detail] = await Promise.all([
      readFile("apps/web/src/process-configuration-form.tsx", "utf8"),
      readFile("apps/api/src/rework/rework-business-detail-service.ts", "utf8"),
    ]);
    expect(form).toContain("reviewSeparationBlocked");
    expect(form).toContain("detail.createdBy.userId");
    expect(form).toContain("detail.processConfigurationCreatedBy?.userId");
    expect(form).toContain("按审核分离规则不能进行 IE 自审");
    expect(form).toContain("多人补验");
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

  it("keeps N07 responsibility rows valid and transfer targets human-readable", async () => {
    const [panel, service, routes] = await Promise.all([
      readFile("apps/web/src/responsibility-determination-panel.tsx", "utf8"),
      readFile("apps/api/src/rework/responsibility-determination-application-service.ts", "utf8"),
      readFile("apps/api/src/rework/responsibility-determination-routes.ts", "utf8"),
    ]);
    expect(panel).toContain("allocation.shareBps > 0n");
    expect(panel).toContain("shareTotalBps(process.allocations) === 10000n");
    expect(panel).toContain("输入姓名搜索");
    expect(panel).toContain("ResponsibilityTransferOptionsResponseSchema");
    expect(panel).not.toContain('label="目标用户 UUID"');
    expect(service).toContain("responsibility_can_determine(u.id,$2)");
    expect(service).toContain("只有当前有效责任处理人可以查看转交对象");
    expect(routes).toContain("responsibility-determinations/transfer-options");
  });

  it("keeps process, execution and wage work reachable from their permitted primary entries", async () => {
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
    expect(detail).toContain('title: "责任与归档"');
    expect(detail).toContain('node("initiation", "01"');
    expect(detail).toContain('node("responsibility_settlement", "08"');
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

  it("prevalidates N10-B deduction and unresolved-difference closure inputs", async () => {
    const source = await readFile(
      "apps/web/src/external-responsibility-panel.tsx",
      "utf8",
    );
    expect(source).toContain("请先填写大于 0、最多两位小数的实际扣款金额");
    expect(source).toContain("部分扣款或未扣成功关闭必须先上传扣款结果证据");
    expect(source).toContain("部分扣款或未扣成功关闭必须填写剩余差额最终处理方式");
  });

  it("keeps N07-N08 queue navigation real without exposing dead or unauthorized header links", async () => {
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

  it("keeps N08-A approval retry-safe and visually prioritizes the safe forward action", async () => {
    const source = await readFile(
      "apps/web/src/own-factory-approval-panel.tsx",
      "utf8",
    );
    expect(source).toContain("pendingDecisionKeys");
    expect(source).toContain('"idempotency-key": idempotencyKey');
    expect(source).toContain('variant="primary" disabled={Boolean(busy)} onClick={() => void decide("approved")}');
    expect(source).toContain('<Button disabled={Boolean(busy)} onClick={() => void decide("rejected")}>驳回并退回 N07</Button>');
  });
});
