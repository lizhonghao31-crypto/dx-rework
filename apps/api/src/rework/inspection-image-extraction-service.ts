import { request as httpsRequest } from "node:https";

import {
  InspectionReportImageExtractionSchema,
  type InspectionReportImageExtraction,
} from "@dx-rework/contracts";

import { ApplicationError } from "../platform/errors.js";

type InspectionImageTransport = (input: Readonly<{
  provider: "openai" | "dashscope";
  apiKey: string;
  model: string;
  baseUrl: string;
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
  "只返回 JSON 对象，不要解释。JSON 字段必须且仅包含 supplierName、styleNo、styleName、color、inspectionStage、inspectionLocation、orderQuantity、sampleQuantity。",
].join("\n");

export const buildInspectionImageProviderRequest = (input: Readonly<{
  provider: "openai" | "dashscope";
  model: string;
  baseUrl: string;
  imageUrl: string;
}>): Readonly<{ url: string; payload: string }> => {
  if (input.provider === "dashscope") {
    const baseUrl = input.baseUrl.endsWith("/") ? input.baseUrl : `${input.baseUrl}/`;
    return {
      url: new URL("chat/completions", baseUrl).toString(),
      payload: JSON.stringify({
        model: input.model,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: instruction },
            { type: "image_url", image_url: { url: input.imageUrl } },
          ],
        }],
        response_format: { type: "json_object" },
        enable_thinking: false,
        stream: false,
      }),
    };
  }
  return {
    url: new URL("responses", input.baseUrl.endsWith("/") ? input.baseUrl : `${input.baseUrl}/`).toString(),
    payload: JSON.stringify({
      model: input.model,
      store: false,
      input: [{
        role: "user",
        content: [
          { type: "input_text", text: instruction },
          { type: "input_image", image_url: input.imageUrl, detail: "high" },
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
    }),
  };
};

const providerFailure = (statusCode: number): ApplicationError => {
  if (statusCode === 401 || statusCode === 403) {
    return new ApplicationError("VISION_PROVIDER_AUTH_FAILED", "图片识别服务鉴权失败，请联系管理员", 503);
  }
  if (statusCode === 429) {
    return new ApplicationError("VISION_PROVIDER_QUOTA_EXCEEDED", "图片识别服务额度不足，请联系管理员", 503);
  }
  return new ApplicationError("VISION_UNAVAILABLE", "图片识别暂时不可用，请手动填写", 503);
};

const defaultTransport: InspectionImageTransport = async ({ provider, apiKey, model, baseUrl, imageUrl }) => {
  const requestInput = buildInspectionImageProviderRequest({ provider, model, baseUrl, imageUrl });

  return new Promise<unknown>((resolve, reject) => {
    const request = httpsRequest(requestInput.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        "content-length": Buffer.byteLength(requestInput.payload),
      },
      timeout: 45_000,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        if ((response.statusCode ?? 500) >= 300) {
          reject(providerFailure(response.statusCode ?? 500));
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
    request.end(requestInput.payload);
  });
};

const outputText = (provider: "openai" | "dashscope", value: unknown): string | null => {
  if (!value || typeof value !== "object") return null;
  if (provider === "dashscope") {
    const choices = (value as { choices?: unknown }).choices;
    if (!Array.isArray(choices)) return null;
    for (const choice of choices) {
      if (!choice || typeof choice !== "object") continue;
      const message = (choice as { message?: unknown }).message;
      if (!message || typeof message !== "object") continue;
      const content = (message as { content?: unknown }).content;
      if (typeof content === "string") return content;
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
          return (part as { text: string }).text;
        }
      }
    }
    return null;
  }
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
    private readonly options: Readonly<{
      provider?: "openai" | "dashscope";
      apiKey: string | undefined;
      model: string;
      baseUrl?: string;
    }>,
    private readonly transport: InspectionImageTransport = defaultTransport,
  ) {}

  async extract(imageUrl: string): Promise<InspectionReportImageExtraction> {
    if (!this.options.apiKey) {
      throw new ApplicationError("VISION_NOT_CONFIGURED", "图片识别尚未配置，请先手动填写八项资料", 503);
    }
    const provider = this.options.provider ?? "openai";
    const baseUrl = this.options.baseUrl
      ?? (provider === "dashscope"
        ? "https://dashscope.aliyuncs.com/compatible-mode/v1"
        : "https://api.openai.com/v1");
    let response: unknown;
    try {
      response = await this.transport({
        provider,
        apiKey: this.options.apiKey,
        model: this.options.model,
        baseUrl,
        imageUrl,
      });
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw new ApplicationError("VISION_UNAVAILABLE", "图片识别暂时不可用，请手动填写", 503);
    }
    const text = outputText(provider, response);
    if (!text) throw new ApplicationError("VISION_RESPONSE_INVALID", "图片识别未返回可用结果，请手动填写", 502);
    try {
      return InspectionReportImageExtractionSchema.parse(JSON.parse(text) as unknown);
    } catch {
      throw new ApplicationError("VISION_RESPONSE_INVALID", "图片识别结果不完整，请手动填写", 502);
    }
  }
}
