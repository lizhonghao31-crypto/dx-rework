import { describe, expect, it } from "vitest";

import { InspectionImageExtractionService } from "../../apps/api/src/rework/inspection-image-extraction-service.js";

const validResult = {
  supplierName: "嘉顺",
  styleNo: "GA20537717",
  styleName: "男短T恤",
  color: "浅灰色",
  inspectionStage: "reinspection",
  inspectionLocation: "一厂验货区",
  orderQuantity: 1000,
  sampleQuantity: 80,
};

describe("inspection image extraction", () => {
  it("accepts only the eight constrained paper-report fields", async () => {
    const service = new InspectionImageExtractionService(
      { apiKey: "test-key", model: "gpt-5.6" },
      async () => ({ output_text: JSON.stringify(validResult) }),
    );
    await expect(service.extract("https://signed.example.test/report.jpg")).resolves.toEqual(validResult);
  });

  it("fails closed when the model response is missing a required extraction key", async () => {
    const service = new InspectionImageExtractionService(
      { apiKey: "test-key", model: "gpt-5.6" },
      async () => ({ output_text: JSON.stringify({ ...validResult, styleName: undefined }) }),
    );
    await expect(service.extract("https://signed.example.test/report.jpg")).rejects.toMatchObject({
      code: "VISION_RESPONSE_INVALID",
    });
  });

  it("does not attempt any network call without a server-side API key", async () => {
    let called = false;
    const service = new InspectionImageExtractionService(
      { apiKey: undefined, model: "gpt-5.6" },
      async () => {
        called = true;
        return { output_text: JSON.stringify(validResult) };
      },
    );
    await expect(service.extract("https://signed.example.test/report.jpg")).rejects.toMatchObject({
      code: "VISION_NOT_CONFIGURED",
    });
    expect(called).toBe(false);
  });
});
