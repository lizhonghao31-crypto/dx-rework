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

  it("maps prefixed Vite assets to artifact assets without an SPA fallback", async () => {
    const config = await readFile("infra/nginx/dx-rework.conf.example", "utf8");
    const assets = config.indexOf("location ^~ /rework/assets/");
    const spa = config.indexOf("location / {");
    expect(assets).toBeGreaterThan(-1);
    expect(assets).toBeLessThan(spa);
    const block = config.slice(assets, spa);
    expect(block).toContain("alias /opt/dx-rework/frontend/current/assets/;");
    expect(block).not.toContain("index.html");
  });

  it("keeps the external proxy contract aligned with Fastify's stripped route", async () => {
    const nginx = await readFile("infra/nginx/dx-rework.conf.example", "utf8");
    const routes = await readFile("apps/api/src/auth/routes.ts", "utf8");
    expect(nginx.match(/proxy_pass http:\/\/127\.0\.0\.1:3201\/;/g)).toHaveLength(2);
    expect(routes).toContain('app.get("/protected"');
    expect(routes).not.toContain('app.get("/api/protected"');
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

  it("suppresses request-line error diagnostics for exact OAuth callbacks", async () => {
    const config = await readFile("infra/nginx/dx-rework.conf.example", "utf8");
    for (const path of ["/api/auth/qr/callback", "/rework/api/auth/qr/callback"]) {
      const start = config.indexOf(`location = ${path} {`);
      expect(start).toBeGreaterThan(-1);
      const block = config.slice(start, config.indexOf("\n    }", start) + 6);
      expect(block).toContain("error_log /dev/null emerg;");
      expect(block).toContain("proxy_pass http://127.0.0.1:3201/auth/qr/callback;");
    }
  });
});
