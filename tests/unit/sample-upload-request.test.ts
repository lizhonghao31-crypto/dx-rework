import Fastify from "fastify";
import { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sampleRequest, sampleErrorMessage } from "../../apps/web/src/sample-request.js";

afterEach(() => vi.unstubAllGlobals());
describe("sample upload HTTP boundary", () => {
  it("reproduces empty JSON rejection and sends bodyless finalize to the handler", async () => {
    const app = Fastify();
    const finalize = vi.fn(async () => ({ status: "ready" }));
    app.post("/finalize", finalize);
    try {
      expect((await app.inject({ method: "POST", url: "/finalize", headers: { "content-type": "application/json" } })).statusCode).toBe(400);
      expect(finalize).not.toHaveBeenCalled();
      vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
        const response = await app.inject({ method: "POST", url, headers: Object.fromEntries(new Headers(init.headers)) });
        return new Response(response.body, { status: response.statusCode });
      }));
      await expect(sampleRequest("/finalize", z.object({ status: z.literal("ready") }), { method: "POST" })).resolves.toEqual({ status: "ready" });
      expect(finalize).toHaveBeenCalledTimes(1);
    } finally { await app.close(); }
  });

  it("retains JSON bodies, credentials and caller headers for upload intent and creation", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response('{"ok":true}'));
    vi.stubGlobal("fetch", fetcher);
    await sampleRequest("/intent", z.object({ ok: z.boolean() }), { method: "POST", body: '{"filename":"receipt.png"}', headers: new Headers({ "idempotency-key": "fixture-request" }) });
    const init = fetcher.mock.calls[0]![1] as RequestInit;
    expect(new Headers(init.headers).get("content-type")).toBe("application/json");
    expect(new Headers(init.headers).get("idempotency-key")).toBe("fixture-request");
    expect(init).toMatchObject({ credentials: "include", cache: "no-store", body: '{"filename":"receipt.png"}' });
  });

  it("reports English validation errors in Chinese without hiding authentication failures", async () => {
    for (const [status, message] of [[400, "提交资料未通过校验"], [401, "登录已失效"], [403, "当前账号无权"]] as const) {
      vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: { code: "VALIDATION_ERROR", message: "Request validation failed" } }), { status }));
      const error = await sampleRequest("/intent", z.unknown(),{method:"POST"}).catch(error => error);
      expect(sampleErrorMessage(error)).toContain(message);
      expect(sampleErrorMessage(error)).not.toContain("Request validation failed");
    }
  });

  it("handles non-JSON and incomplete responses with a readable retry message", async () => {
    vi.stubGlobal("fetch", async () => new Response("unavailable", { status: 502 }));
    await expect(sampleRequest("/intent", z.object({ id: z.string() }))).rejects.toThrow("未能读取原资料");
    vi.stubGlobal("fetch", async () => new Response("{}"));
    await expect(sampleRequest("/intent", z.object({ id: z.string() }))).rejects.toThrow("返回资料不完整或格式异常");
  });
});
