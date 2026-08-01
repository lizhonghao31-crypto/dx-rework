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

  it("uses a query-free access log format for every location", async () => {
    const config = await readFile("infra/nginx/dx-rework.conf.example", "utf8");
    const format = config.match(/log_format\s+dx_rework_query_free\s+([\s\S]*?);/)?.[1];
    expect(format).toBeDefined();
    expect(format).toContain("$request_method");
    expect(format).toContain("$uri");
    expect(format).toContain("$request_id");
    for (const unsafeVariable of ["$request", "$request_uri", "$args", "$query_string", "$http_referer"]) {
      expect(format).not.toMatch(new RegExp(`\\${unsafeVariable}(?![A-Za-z0-9_])`));
    }
    expect(config).toMatch(/access_log\s+\/opt\/dx-rework\/logs\/nginx-access\.log\s+dx_rework_query_free;/);
    expect(config).not.toMatch(/access_log[^;]*\scombined;/);
  });
});
