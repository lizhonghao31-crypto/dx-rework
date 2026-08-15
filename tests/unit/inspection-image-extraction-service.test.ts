import { describe, expect, it } from "vitest";

import {
  buildInspectionImageProviderRequest,
  InspectionImageExtractionService,
} from "../../apps/api/src/rework/inspection-image-extraction-service.js";

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

  it("builds a non-thinking DashScope vision request with JSON output", () => {
    const request = buildInspectionImageProviderRequest({
      provider: "dashscope",
      model: "qwen3-vl-plus",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      imageUrl: "https://signed.example.test/report.jpg",
    });
    expect(request.url).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions");
    expect(request.payload).toContain('"model":"qwen3-vl-plus"');
    expect(request.payload).toContain('"response_format":{"type":"json_object"}');
    expect(request.payload).toContain('"enable_thinking":false');
    expect(request.payload).toContain('"image_url":{"url":"https://signed.example.test/report.jpg"}');
  });

  it("reads the eight fields from a DashScope compatible response", async () => {
    const service = new InspectionImageExtractionService(
      {
        provider: "dashscope",
        apiKey: "test-key",
        model: "qwen3-vl-plus",
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      },
      async (input) => {
        expect(input.provider).toBe("dashscope");
        return { choices: [{ message: { content: JSON.stringify(validResult) } }] };
      },
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
