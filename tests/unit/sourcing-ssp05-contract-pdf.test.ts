import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  SourcingContractStateResponseSchema,
  SupplementSourcingContractSchema,
} from "@dx-rework/contracts";
import { describe, expect, it } from "vitest";

import {
  renderSourcingContractPdf,
  sourcingContractFingerprint,
  type ContractPdfSnapshot,
} from "../../apps/api/src/sourcing/sourcing-contract-pdf.js";

const snapshot: ContractPdfSnapshot = {
  contractNumber: "DX-WF-20260905-000001",
  contractDate: "2026-09-05",
  partyAName: "广州达兴服装有限公司",
  partyBName: "广州测试加工厂有限公司",
  partyBAddress: "广州市番禺区测试路 1 号",
  partyBRepresentative: "陈代表",
  payeeName: "陈收款",
  bankAccount: "6222000000000000",
  bankName: "测试银行广州支行",
  signingPlace: "广州",
  estimatedCutPieceSendDate: "2026-09-06",
  deliveryDate: "2026-09-20",
  processes: ["车缝", "整烫"],
  lines: [
    { position: 1,styleNo: "DX-A01",alternateStyleNo: "A01-B",color: "黑色",quantity: 3,unitPrice: "10.1250",totalAmount: "30.38" },
    { position: 2,styleNo: "DX-A02",alternateStyleNo: null,color: "白色",quantity: 2,unitPrice: "20.3350",totalAmount: "40.67" },
  ],
  totalQuantity: 5,
  totalAmount: "71.05",
  terms: {
    processingResponsibility: "乙方按确认工艺完成加工。",
    qualityRequirements: "乙方按确认质量标准交付。",
    delayPenalty: "延期事实据实处理。",
    logistics: "按订单节点交接留痕。",
    reasonableLoss: "合理损耗以核定记录为准。",
    defectRate: "次品责任以验收记录为准。",
    payment: "按合格数量与合同价格结算。",
    validity: "双方确认后生效。",
  },
};

describe("SSP-05 contract PDF", () => {
  it("renders multi-style exact amounts as extractable Chinese PDF text", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dx-contract-"));
    try {
      const pdfPath = join(directory, "contract.pdf");
      const textPath = join(directory, "contract.txt");
      const pdf = renderSourcingContractPdf(snapshot);
      await writeFile(pdfPath, pdf);
      execFileSync("pdftotext", [pdfPath, textPath]);
      const text = await readFile(textPath, "utf8");
      expect(text).toContain("外发服装加工合同");
      expect(text).toContain("DX-A01");
      expect(text).toContain("DX-A02");
      expect(text).toContain("30.38");
      expect(text).toContain("40.67");
      expect(text).toContain("71.05");
      expect(text).not.toContain("达兴价格");
      expect(text).not.toContain("88.8888");
    } finally {
      await rm(directory, { recursive: true,force: true });
    }
  });

  it("keeps the fingerprint stable and contract DTO free of internal Daxing price", () => {
    expect(sourcingContractFingerprint(snapshot)).toBe(sourcingContractFingerprint({ ...snapshot }));
    const state = SourcingContractStateResponseSchema.parse({
      item: {
        sourcingContractDocumentId: "00000000-0000-4000-8000-000000000501",
        sourcingApprovalSnapshotId: "00000000-0000-4000-8000-000000000502",
        contractNumber: snapshot.contractNumber,
        contractVersion: 1,
        templateVersion: 1,
        status: "ready",
        missingFields: [],
        snapshotFingerprint: "a".repeat(64),
        pdfAttachmentId: "00000000-0000-4000-8000-000000000503",
        pdfSha256: "b".repeat(64),
        failureReason: null,
        preparedAt: "2026-09-05T00:00:00.000Z",
        generatedAt: "2026-09-05T00:00:01.000Z",
        canSupplement: false,
      },
    });
    expect(JSON.stringify(state)).not.toMatch(/daxing|达兴价格/i);
  });

  it("accepts only explicit non-empty supplement fields", () => {
    expect(SupplementSourcingContractSchema.safeParse({}).success).toBe(false);
    expect(SupplementSourcingContractSchema.safeParse({ address: " " }).success).toBe(false);
    expect(SupplementSourcingContractSchema.parse({ address: "广州市番禺区" })).toEqual({ address: "广州市番禺区" });
    expect(SupplementSourcingContractSchema.safeParse({ address: "地址", daxingUnitPrice: "88.8888" }).success).toBe(false);
  });
});

