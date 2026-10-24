import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { ApplicationError } from "../../apps/api/src/platform/errors.js";
import { SourcingService, type FactoryChangeFailureDiagnostic } from "../../apps/api/src/sourcing/sourcing-service.js";

const actor = {
  actorId: "00000000-0000-4000-8000-000000000001",
  actorRoles: ["root_superuser"],
  authorizationCapability: "sourcing:owner:approve",
  requestId: "factory-change-error-test",
};
const caseId = "00000000-0000-4000-8000-000000000002";
const input = {
  supplierId: "00000000-0000-4000-8000-000000000003",
  unitPrice: "11.3",
  changeReason: "更换加工厂",
};
const quantityConstraint = "sourcing_factory_change_request_quantity_current";
type Reporter = (diagnostic: FactoryChangeFailureDiagnostic) => void | Promise<void>;

function failingRequest(failure: unknown, options: {
  reporter?: Reporter;
  failRollback?: boolean;
  omitReporter?: boolean;
} = {}) {
  const report = vi.fn<Reporter>(options.reporter);
  const query = vi.fn(async (sql: string) => {
    if (sql === "ROLLBACK" && options.failRollback) throw new Error("rollback unavailable");
    if (sql === "BEGIN" || sql === "ROLLBACK") return { rows: [], rowCount: 0 };
    throw failure;
  });
  const release = vi.fn();
  const pool = { connect: vi.fn(async () => ({ query, release })) } as unknown as Pool;
  const service = new SourcingService(
    pool, undefined, undefined, undefined, undefined,
    options.omitReporter ? undefined : report,
  );
  return {
    query, release, report,
    submit: () => service.requestFactoryChange(actor, caseId, input, "factory-change-error-test"),
  };
}

describe("factory change request failure diagnostics", () => {
  it("maps the named quantity guard and records only safe diagnostics after rollback", async () => {
    const failure = Object.assign(new Error("sensitive database failure"), {
      code: "23514",
      constraint: quantityConstraint,
      detail: "sensitive order values",
      where: "sensitive SQL function context",
      query: "sensitive SQL statement",
      credentials: "sensitive authentication material",
    });
    const request = failingRequest(failure);
    expect(request.report).not.toHaveBeenCalled();

    const returned = await request.submit().catch((error: unknown) => error);
    expect(returned).toMatchObject({
      code: "FACTORY_CHANGE_QUANTITY_MISMATCH",
      statusCode: 409,
      message: "转厂数量与当前订单数量不一致，转厂未完成",
    });
    for (const field of ["constraint", "detail", "where", "query", "credentials", "cause"])
      expect(returned).not.toHaveProperty(field);
    expect(request.report).toHaveBeenCalledExactlyOnceWith({
      requestId: actor.requestId, pgCode: "23514", constraint: quantityConstraint,
    });
    expect(JSON.stringify(request.report.mock.calls)).not.toContain("sensitive");
    expect(request.query).toHaveBeenLastCalledWith("ROLLBACK");
    expect(request.query.mock.invocationCallOrder.at(-1)).toBeLessThan(request.report.mock.invocationCallOrder[0]!);
    expect(request.report.mock.invocationCallOrder[0]).toBeLessThan(request.release.mock.invocationCallOrder[0]!);
    expect(request.release).toHaveBeenCalledOnce();
  });

  it.each([
    ["23514", "another_check", "转厂校验未通过，转厂未完成"],
    ["23505", "another_unique_key", "转厂记录存在冲突，转厂未完成"],
    ["23505", quantityConstraint, "转厂记录存在冲突，转厂未完成"],
  ])("keeps the existing conflict code for %s / %s without claiming a stale page", async (code, constraint, message) => {
    const request = failingRequest({ code, constraint });
    await expect(request.submit()).rejects.toMatchObject({
      code: "INVALID_STATE_TRANSITION", statusCode: 409, message,
    });
    expect(request.report).toHaveBeenCalledExactlyOnceWith({ requestId: actor.requestId, pgCode: code, constraint });
    expect(request.release).toHaveBeenCalledOnce();
  });

  it.each(["unsafe\nSQL", "a".repeat(64), 123])("omits unsafe constraint metadata: %s", async (constraint) => {
    const request = failingRequest({ code: "23514", constraint });
    await expect(request.submit()).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
    expect(request.report).toHaveBeenCalledExactlyOnceWith({ requestId: actor.requestId, pgCode: "23514" });
  });

  it.each(["23514\nSQL", 23514, "NOT_A_SQLSTATE"])("does not log or classify a malformed database code: %s", async (code) => {
    const failure = { code, detail: "sensitive details" };
    const request = failingRequest(failure);
    await expect(request.submit()).rejects.toBe(failure);
    expect(request.report).toHaveBeenCalledExactlyOnceWith({ requestId: actor.requestId });
    expect(request.release).toHaveBeenCalledOnce();
  });

  it.each([
    ["synchronous failure", () => { throw new Error("diagnostic unavailable"); }],
    ["rejected promise", () => Promise.reject(new Error("diagnostic unavailable"))],
    ["pending promise", () => new Promise<void>(() => undefined)],
  ] satisfies [string, Reporter][])("does not let %s delay cleanup or mask the original failure", async (_name, reporter) => {
    const failure = new Error("original request failure");
    const request = failingRequest(failure, { reporter, failRollback: true });
    await expect(request.submit()).rejects.toBe(failure);
    expect(request.query).toHaveBeenLastCalledWith("ROLLBACK");
    expect(request.report).toHaveBeenCalledOnce();
    expect(request.release).toHaveBeenCalledOnce();
  });

  it("preserves existing application errors and supports callers without a diagnostic callback", async () => {
    const failure = new ApplicationError("FORBIDDEN", "当前岗位无权执行该操作", 403);
    const request = failingRequest(failure, { omitReporter: true });
    await expect(request.submit()).rejects.toBe(failure);
    expect(request.report).not.toHaveBeenCalled();
    expect(request.query).toHaveBeenLastCalledWith("ROLLBACK");
    expect(request.release).toHaveBeenCalledOnce();
  });
});
