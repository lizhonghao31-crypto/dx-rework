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

  it("does not send zero-share N07 responsibility rows", async () => {
    const source = await readFile(
      "apps/web/src/responsibility-determination-panel.tsx",
      "utf8",
    );
    expect(source).toContain("allocation.shareBps > 0n");
    expect(source).toContain("total === 10000n");
  });

  it("keeps process, work and wage nodes inside the shared numbered workflow shell", async () => {
    const [app, shell] = await Promise.all([
      readFile("apps/web/src/App.tsx", "utf8"),
      readFile("apps/web/src/components.tsx", "utf8"),
    ]);
    expect(app).toContain('<Shell active="工序配置"><ProcessConfigurationForm /></Shell>');
    expect(app).toContain('<Shell active="分工上数"><WorkReportingForm /></Shell>');
    expect(app).toContain('<Shell active="工资核对"><WagePage path={path} /></Shell>');
    expect(shell).toContain('name: "工序配置"');
    expect(shell).toContain('href: "/ui/process-configuration"');
    expect(shell).toContain('name: "分工上数"');
    expect(shell).toContain('href: "/ui/work-reporting"');
    expect(shell).toContain('name: "工资核对"');
    expect(shell).toContain('href: "/ui/wages"');
    expect(shell).toContain('step: "0"');
    expect(shell).toContain('step: "12"');
    expect(shell).toContain("flow-navigation__arrow");
    expect(shell).toContain('name: "权限管理"');
    expect(shell).toContain('name: "系统管理"');
  });

  it("keeps high-frequency business selectors searchable without exposing internal IDs", async () => {
    const [initiation, processConfiguration, workReporting] = await Promise.all([
      readFile("apps/web/src/rework-form.tsx", "utf8"),
      readFile("apps/web/src/process-configuration-form.tsx", "utf8"),
      readFile("apps/web/src/work-reporting-form.tsx", "utf8"),
    ]);
    expect(initiation).toContain("<SearchSelect");
    expect(initiation).toContain("输入姓名搜索订单跟单");
    expect(initiation).toContain("<FactorySearch");
    expect(processConfiguration).toContain("输入工序名称搜索");
    expect(processConfiguration).toContain("selectCatalogProcess");
    expect(workReporting).toContain("搜索返工人员");
    expect(workReporting).toContain("filteredPeople");
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
    expect(shell).toContain('name: "人员资料"');
    expect(shell).toContain('href: "/ui/people"');
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
});
