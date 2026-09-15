import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as root from "@dx-rework/contracts";
import * as dedicated from "@dx-rework/contracts/external-responsibility";
import { describe, expect, it, vi } from "vitest";
import { readExternalResponsibilityResponse } from "../../apps/web/src/external-responsibility-response.js";

const id = randomUUID();
const request = {
  requestId: id, requestVersion: 1, reason: "测试特批", attachmentIds: [id],
  proposedAmount: "139.44", actualDeductedAmount: "140.00", remainingAmount: "-0.56",
  requestedBy: id, requestedAt: "2026-09-15T00:00:00.000Z", decision: null,
};
const caseData = {
  caseId: id, batchId: id, reworkOrderId: id, responsibilityType: "processing_factory",
  supplier: { supplierId: id, version: 1, code: "TEST", name: "测试工厂", type: "factory" },
  businessHandlerUserId: id, payablesHandlerRole: "processing_factory_payables",
  proposedDeductionAmount: "139.44", actualDeductedAmount: "140.00", remainingAmount: "-0.56",
  caseVersion: 1, status: "pending_special_approval", submittedAt: null, payablesConfirmedAt: null,
  canSign: false, canPayablesConfirm: false, canFollowUp: false, canRecordDeduction: false,
  canClose: false, canRequestSpecialApproval: false, canDecideSpecialApproval: false,
  canRequestRevision: false, canApproveRevision: false,
  items: [], deductions: [], followUps: [], closure: null, revisionRequests: [],
  evidenceAttachments: [{ attachmentId: id, filename: "凭证.pdf", mimeType: "application/pdf" }],
  specialApproval: request, specialApprovalHistory: [request],
};
const batch = {
  batchId: id, reworkOrderId: id, finalizedDeterminationId: id,
  finalizedDeterminationVersion: 1, batchVersion: 1, status: "active", sourceSnapshot: {},
  items: [], cases: [caseData], historicalCases: [{ ...caseData, status: "superseded" }],
  canAllocateSuppliers: false,
};

describe("external deduction canonical runtime contracts", () => {
  it("retains evidence, historical cases and denied capabilities through both package entrypoints", () => {
    expect(root.ExternalResponsibilityBatchResponseSchema).toBe(dedicated.ExternalResponsibilityBatchResponseSchema);
    expect(root.ExternalResponsibilityCaseResponseSchema).toBe(dedicated.ExternalResponsibilityCaseResponseSchema);
    expect(root.ExternalResponsibilityBatchResponseSchema.parse(batch)).toEqual(batch);
    expect(root.ExternalResponsibilityBatchResponseSchema.safeParse({ ...batch, unauthorizedField: true }).success).toBe(false);
    expect(root.CreateExternalDeductionEntrySchema).toBe(dedicated.CreateExternalDeductionEntrySchema);
    expect(root.CreateExternalDeductionEntrySchema.safeParse({ expectedCaseVersion: 1, entryType: "deduction", amount: "1.00", deductedOn: "2026-09-15", canDecideSpecialApproval: true }).success).toBe(false);
  });

  it("reads older responses without optional display fields without granting missing capabilities", () => {
    const olderCase = { ...caseData, evidenceAttachments: undefined, specialApprovalHistory: undefined };
    const olderBatch = { ...batch, historicalCases: undefined, canAllocateSuppliers: undefined };
    const value = root.ExternalResponsibilityBatchResponseSchema.parse({ ...olderBatch, cases: [olderCase] });
    expect(value?.canAllocateSuppliers).toBeUndefined();
    expect(value?.cases[0]?.canDecideSpecialApproval).toBe(false);
    expect(root.ExternalResponsibilityBatchResponseSchema.parse(null)).toBeNull();
  });

  it("checks real compiled root, compatibility and dedicated exports in a separate Node process", () => {
    const script = `
      import assert from 'node:assert/strict';
      import * as root from './packages/contracts/dist/index.js';
      import * as compat from './packages/contracts/dist/compat-index.js';
      import * as dedicated from './packages/contracts/dist/external-responsibility.js';
      for (const module of [root, compat, dedicated]) {
        assert.equal(module.ExternalResponsibilityBatchResponseSchema, dedicated.ExternalResponsibilityBatchResponseSchema);
        assert.deepEqual(module.ExternalResponsibilityBatchResponseSchema.parse(${JSON.stringify(batch)}), ${JSON.stringify(batch)});
      }
    `;
    execFileSync(process.execPath, ["--input-type=module", "-e", script], { cwd: new URL("../..", import.meta.url), stdio: "pipe" });
  });

  it("reports failed reads and successful writes with invalid replies differently, retaining request correlation", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = () => Response.json({ unrecognized: true }, { headers: { "x-request-id": "test-request" } });
    await expect(readExternalResponsibilityResponse(response(), dedicated.ExternalResponsibilityBatchResponseSchema, "read"))
      .rejects.toThrow("扣款资料加载失败，请刷新重试。（请求编号：test-request）");
    await expect(readExternalResponsibilityResponse(response(), dedicated.ExternalResponsibilityCaseResponseSchema, "write"))
      .rejects.toThrow("提交已获服务器响应，但结果暂未能显示。请先刷新核对台账，勿重复录入。");
    expect(log).toHaveBeenCalledTimes(2);
    expect(await readExternalResponsibilityResponse(Response.json(batch), dedicated.ExternalResponsibilityBatchResponseSchema, "read")).toEqual(batch);
  });
});
