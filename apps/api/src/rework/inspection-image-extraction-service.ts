import { request as httpsRequest } from "node:https";

import {
  InspectionReportImageExtractionSchema,
  type InspectionReportImageExtraction,
} from "@dx-rework/contracts";

import { ApplicationError } from "../platform/errors.js";

type OpenAiTransport = (input: Readonly<{
  apiKey: string;
  model: string;
  imageUrl: string;
}>) => Promise<unknown>;

const extractionSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "supplierName",
    "styleNo",
    "styleName",
    "color",
    "inspectionStage",
    "inspectionLocation",
    "orderQuantity",
    "sampleQuantity",
  ],
  properties: {
    supplierName: { type: ["string", "null"] },
    styleNo: { type: ["string", "null"] },
    styleName: { type: ["string", "null"] },
    color: { type: ["string", "null"] },
    inspectionStage: { type: ["string", "null"], enum: ["midline", "final", "warehouse", "reinspection", null] },
    inspectionLocation: { type: ["string", "null"] },
    orderQuantity: { type: ["integer", "null"], minimum: 1 },
    sampleQuantity: { type: ["integer", "null"], minimum: 1 },
  },
} as const;

const instruction = [
  "你是服装纸质验货报告的结构化识别器。",
  "仅从图片读取手写或印刷内容及勾选框；不要根据常识补全。无法清晰确认时必须填 null。",
  "inspectionStage 必须映射为：中查=midline、尾查=final、仓检=warehouse、复检=reinspection。",
  "只返回规定 JSON，不要解释。",
].join("\n");

const defaultTransport: OpenAiTransport = async ({ apiKey, model, imageUrl }) => {
  const payload = JSON.stringify({
    model,
    store: false,
    input: [{
      role: "user",
      content: [
        { type: "input_text", text: instruction },
        { type: "input_image", image_url: imageUrl, detail: "high" },
      ],
    }],
    text: {
      format: {
        type: "json_schema",
        name: "inspection_report_extraction",
        strict: true,
        schema: extractionSchema,
      },
    },
  });

  return new Promise<unknown>((resolve, reject) => {
    const request = httpsRequest("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload),
      },
      timeout: 45_000,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        if ((response.statusCode ?? 500) >= 300) {
          reject(new ApplicationError("VISION_UNAVAILABLE", "图片识别暂时不可用，请手动填写", 503));
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
        } catch {
          reject(new ApplicationError("VISION_RESPONSE_INVALID", "图片识别返回格式异常，请手动填写", 502));
        }
      });
    });
    request.on("timeout", () => request.destroy(new Error("timeout")));
    request.on("error", () => reject(new ApplicationError("VISION_UNAVAILABLE", "图片识别暂时不可用，请手动填写", 503)));
    request.end(payload);
  });
};

const outputText = (value: unknown): string | null => {
  if (!value || typeof value !== "object") return null;
  const response = value as { output_text?: unknown; output?: unknown };
  if (typeof response.output_text === "string") return response.output_text;
  if (!Array.isArray(response.output)) return null;
  for (const item of response.output) {
    if (!item || typeof item !== "object") continue;
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
        return (part as { text: string }).text;
      }
    }
  }
  return null;
};

export class InspectionImageExtractionService {
  constructor(
    private readonly options: Readonly<{ apiKey: string | undefined; model: string }>,
    private readonly transport: OpenAiTransport = defaultTransport,
  ) {}

  async extract(imageUrl: string): Promise<InspectionReportImageExtraction> {
    if (!this.options.apiKey) {
      throw new ApplicationError("VISION_NOT_CONFIGURED", "图片识别尚未配置，请先手动填写八项资料", 503);
    }
    let response: unknown;
    try {
      response = await this.transport({ apiKey: this.options.apiKey, model: this.options.model, imageUrl });
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw new ApplicationError("VISION_UNAVAILABLE", "图片识别暂时不可用，请手动填写", 503);
    }
    const text = outputText(response);
    if (!text) throw new ApplicationError("VISION_RESPONSE_INVALID", "图片识别未返回可用结果，请手动填写", 502);
    try {
      return InspectionReportImageExtractionSchema.parse(JSON.parse(text) as unknown);
    } catch {
      throw new ApplicationError("VISION_RESPONSE_INVALID", "图片识别结果不完整，请手动填写", 502);
    }
  }
}
