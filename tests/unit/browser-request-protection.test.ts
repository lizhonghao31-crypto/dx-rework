import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import { registerBrowserMutationOriginGuard } from "../../apps/api/src/platform/browser-request-protection.js";

const build = async () => {
  const app = Fastify();
  registerBrowserMutationOriginGuard(app, "https://dxerp.org.cn");
  app.post("/mutate", async () => ({ ok: true }));
  app.get("/oauth-callback", async () => ({ ok: true }));
  await app.ready();
  return app;
};

describe("browser mutation origin guard", () => {
  it("allows same-origin browser mutations and non-browser operational clients", async () => {
    const app = await build();
    const sameOrigin = await app.inject({
      method: "POST",
      url: "/mutate",
      headers: { origin: "https://dxerp.org.cn", "sec-fetch-site": "same-origin" },
    });
    const operational = await app.inject({ method: "POST", url: "/mutate" });
    expect(sameOrigin.statusCode).toBe(200);
    expect(operational.statusCode).toBe(200);
    await app.close();
  });

  it.each([
    ["https://evil.example", "cross-site"],
    ["https://staging-api.dxerp.org.cn", "same-site"],
    ["null", "cross-site"],
  ])("rejects unsafe browser mutations from %s", async (origin, site) => {
    const app = await build();
    const response = await app.inject({
      method: "POST",
      url: "/mutate",
      headers: { origin, "sec-fetch-site": site },
    });
    expect(response.statusCode).toBe(403);
    expect(response.body).not.toContain(origin);
    await app.close();
  });

  it.each(["cross-site", "same-site"])("rejects browser mutation metadata without Origin for %s", async (site) => {
    const app = await build();
    const response = await app.inject({
      method: "POST",
      url: "/mutate",
      headers: { "sec-fetch-site": site },
    });
    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it("does not break the GET OAuth callback class, which has its own state and binding protection", async () => {
    const app = await build();
    const response = await app.inject({
      method: "GET",
      url: "/oauth-callback",
      headers: { origin: "https://login.dingtalk.com", "sec-fetch-site": "cross-site" },
    });
    expect(response.statusCode).toBe(200);
    await app.close();
  });

  it("rejects malformed trusted-origin configuration at startup", () => {
    const app = Fastify();
    expect(() => registerBrowserMutationOriginGuard(app, "https://dxerp.org.cn/path")).toThrow(
      "Browser mutation guard requires an absolute origin",
    );
  });
});
