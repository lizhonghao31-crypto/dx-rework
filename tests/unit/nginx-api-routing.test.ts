import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("production Nginx API routing", () => {
  it("routes /rework/api ahead of the SPA and strips the deployment prefix", async () => {
    const config = await readFile("infra/nginx/dx-rework.conf.example", "utf8");
    const prefixed = config.indexOf("location ^~ /rework/api/");
    const spa = config.indexOf("location / {");
    expect(prefixed).toBeGreaterThan(-1);
    expect(prefixed).toBeLessThan(spa);
    expect(config.slice(prefixed, spa)).toContain("proxy_pass http://127.0.0.1:3201/;");
    expect(config.slice(prefixed, spa)).not.toContain("index.html");
    expect(config).toContain("location /api/");
  });
});
