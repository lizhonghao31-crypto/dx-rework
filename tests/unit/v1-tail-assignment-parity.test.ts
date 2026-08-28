import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("V1 tail assignment parity", () => {
  it("reuses the normal formal/temporary worker picker for tail inspection", async () => {
    const source = await readFile("apps/web/src/process-worker-assignment-form.tsx", "utf8");
    expect(source).toContain('<div className="process-worker-picker__heading"><b>整查人员 *</b>');
    expect(source).toContain("onClick={openMobileTailAssignment}>选择本单工人</Button>");
    expect(source).toContain('placeholder="搜索正式工或临时工"');
    expect(source).toContain('{ label: "正式工", people:');
    expect(source).toContain('{ label: "临时工", people:');
    expect(source).toContain("tailPersonIds.map((personId) =>");
    expect(source).toContain("removeTailWorker(personId)");
    expect(source).toContain(': name}{temporary ? " · 临时工" : ""}');
    expect(source).not.toContain('placeholder="搜索整查人员"');
    expect(source).not.toContain('className="process-worker-people-group process-worker-people-group--tail"');
  });

  it("allows active temporary workers to be selected and proxy reported on tail tasks", async () => {
    const [planService, reportingService, migration] = await Promise.all([
      readFile("apps/api/src/rework/process-worker-plan-service.ts", "utf8"),
      readFile("apps/api/src/rework/work-reporting-service.ts", "utf8"),
      readFile("apps/api/migrations/0094_tail_assignment_parity.sql", "utf8"),
    ]);
    expect(planService).toContain("$2='tail_inspection' AND (\n           person.person_type='temporary' OR (");
    expect(reportingService).toContain("(person.person_type='temporary' OR (\n                person.person_type='internal' AND EXISTS");
    expect(reportingService).toContain('if (this.canProxyReport(actor, members)) return "work:report_for_worker";');
    expect(reportingService).toContain("const proxyTask = this.canProxyReport(actor, members);");
    expect(migration).toContain("person_record.person_type<>'temporary'");
  });
});
