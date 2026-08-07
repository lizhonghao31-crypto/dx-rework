import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (path: string) => readFileSync(path, "utf8");

function envFile(directory: string, name: string, body: string): string {
  const path = join(directory, name);
  writeFileSync(path, body);
  chmodSync(path, 0o600);
  return path;
}

describe("PR-17 shared staging /rework contract", () => {
  it("requires an explicit shared_path mode and derives only /rework public bases", () => {
    const directory = mkdtempSync(join(tmpdir(), "pr17-shared-mode-"));
    const app = envFile(directory, "app.env", "APP_BASE_PATH=/rework/\n");
    const deploy = envFile(
      directory,
      "deploy.env",
      [
        "DX_REWORK_NGINX_MODE=shared_path",
        "DX_REWORK_SERVER_NAME=staging-api.dxerp.org.cn",
        "DX_REWORK_PROFILE=pilot",
        "",
      ].join("\n"),
    );
    const result = spawnSync(
      "bash",
      [
        "-c",
        `source scripts/deploy/lib.sh; DX_REWORK_APP_ENV_FILE='${app}' DX_REWORK_DEPLOY_ENV_FILE='${deploy}' load_release_config; printf '%s\\n%s\\n%s\\n' "$DX_REWORK_SMOKE_ORIGIN" "$DX_REWORK_SMOKE_WEB_URL" "$DX_REWORK_SMOKE_API_URL"`,
      ],
      { cwd: root, encoding: "utf8" },
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([
      "https://staging-api.dxerp.org.cn",
      "https://staging-api.dxerp.org.cn/rework",
      "https://staging-api.dxerp.org.cn/rework/api",
    ]);
  });

  it("rejects shared_path when APP_BASE_PATH is not /rework/", () => {
    const directory = mkdtempSync(join(tmpdir(), "pr17-shared-base-"));
    const app = envFile(directory, "app.env", "APP_BASE_PATH=/\n");
    const deploy = envFile(
      directory,
      "deploy.env",
      "DX_REWORK_NGINX_MODE=shared_path\nDX_REWORK_SERVER_NAME=staging-api.dxerp.org.cn\nDX_REWORK_PROFILE=pilot\n",
    );
    const result = spawnSync(
      "bash",
      [
        "-c",
        `source scripts/deploy/lib.sh; DX_REWORK_APP_ENV_FILE='${app}' DX_REWORK_DEPLOY_ENV_FILE='${deploy}' load_release_config`,
      ],
      { cwd: root, encoding: "utf8" },
    );
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("shared_path requires APP_BASE_PATH=/rework/");
  });

  it("preserves dedicated_vhost mode without inferring it from the hostname", () => {
    const directory = mkdtempSync(join(tmpdir(), "pr17-dedicated-mode-"));
    const app = envFile(directory, "app.env", "APP_BASE_PATH=/rework/\n");
    const deploy = envFile(
      directory,
      "deploy.env",
      "DX_REWORK_NGINX_MODE=dedicated_vhost\nDX_REWORK_SERVER_NAME=rework.example.com\nDX_REWORK_PROFILE=pilot\n",
    );
    const result = spawnSync(
      "bash",
      [
        "-c",
        `source scripts/deploy/lib.sh; DX_REWORK_APP_ENV_FILE='${app}' DX_REWORK_DEPLOY_ENV_FILE='${deploy}' load_release_config; printf '%s' "$DX_REWORK_SMOKE_API_URL"`,
      ],
      { cwd: root, encoding: "utf8" },
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toBe("https://rework.example.com");
  });

  it("keeps the shared Nginx snippet inside /rework and path-scopes maintenance", () => {
    const nginx = read("infra/nginx/dx-rework-shared-paths.conf.example");
    expect(nginx).toContain("# DX_REWORK_SHARED_PATHS_BEGIN");
    expect(nginx).toContain("# DX_REWORK_SHARED_PATHS_END");
    expect(nginx).not.toMatch(/^\s*server\s*\{/m);
    expect(nginx).not.toMatch(/^\s*listen\s+/m);
    expect(nginx).not.toMatch(/^\s*server_name\s+/m);
    expect(nginx).not.toContain("location / {");
    expect(nginx).not.toMatch(/location\s+(?:=|\^~)?\s*\/(?:health|version|api\/|assets\/)/);
    for (const location of [
      "location = /rework {",
      "location = /rework/auth/qr/relay {",
      "location = /rework/api/auth/qr/callback {",
      "location ^~ /rework/api/ {",
      "location ^~ /rework/assets/ {",
      "location ^~ /rework/ {",
    ]) {
      expect(nginx.split(location)).toHaveLength(2);
    }
    expect(nginx.match(/if \(-f \/opt\/dx-rework\/shared\/release-switch\.lock\) \{ return 503; \}/g)).toHaveLength(6);
  });

  it("routes only the rework API to 3201 and only the rework frontend to its current alias", () => {
    const nginx = read("infra/nginx/dx-rework-shared-paths.conf.example");
    expect(nginx.match(/proxy_pass http:\/\/127\.0\.0\.1:3201/g)).toHaveLength(2);
    expect(nginx).toContain("proxy_pass http://127.0.0.1:3201/;");
    expect(nginx).toContain("proxy_pass http://127.0.0.1:3201/auth/qr/callback;");
    expect(nginx.match(/root \/opt\/dx-rework\/frontend\/current;/g)).toHaveLength(2);
    expect(nginx).toContain("alias /opt/dx-rework/frontend/current/index.html;");
    expect(nginx).toContain("try_files $uri =404;");
    expect(nginx).toContain("try_files $uri $uri/ /index.html;");
    expect(nginx).not.toMatch(/\/opt\/daxing-(?:erp|sample)/);
  });

  it("suppresses credential-bearing QR relay and callback request-line logs", () => {
    const nginx = read("infra/nginx/dx-rework-shared-paths.conf.example");
    for (const location of [
      "location = /rework/auth/qr/relay {",
      "location = /rework/api/auth/qr/callback {",
    ]) {
      const start = nginx.indexOf(location);
      const end = nginx.indexOf("\n}", start);
      const block = nginx.slice(start, end);
      expect(block).toContain("access_log off;");
      expect(block).toContain("error_log /dev/null emerg;");
    }
  });

  it("keeps bootstrap variables controlled and external smoke off shared root routes", () => {
    const lib = read("scripts/deploy/lib.sh");
    const smoke = read("scripts/deploy/smoke.sh");
    expect(lib).toContain("OWNER_BOOTSTRAP_DINGTALK_USER_ID OWNER_BOOTSTRAP_SECRET");
    expect(lib).toContain("DX_REWORK_NGINX_MODE");
    expect(smoke).toContain('api_base="$DX_REWORK_SMOKE_API_URL"');
    expect(smoke).toContain('web_base="$DX_REWORK_SMOKE_WEB_URL"');
    expect(smoke).toContain('curl -fsS "$web_base/auth/login"');
    expect(smoke).toContain('curl -fsS "$web_base/deep-link-smoke"');
    expect(smoke).not.toContain('curl -fsS "$base/health/live"');
    expect(smoke).not.toContain('json="$(curl -fsS "$base/version")"');
  });
});
