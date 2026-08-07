import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const workflowPath = ".github/workflows/pr-17-infra-inspect.yml";
const scriptPath = "scripts/deploy/inspect-shared-host.sh";

const read = (path: string) => readFile(path, "utf8");

describe("PR-17 read-only infrastructure inspection", () => {
  it("is manual-only and restricted to the pilot environment/current main", async () => {
    const workflow = await read(workflowPath);
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).not.toMatch(/^\s*push:/m);
    expect(workflow).not.toMatch(/^\s*pull_request:/m);
    expect(workflow).toContain("- dx-rework-pilot");
    expect(workflow).not.toContain("dx-rework-production");
    expect(workflow).toContain("git rev-parse origin/main");
    expect(workflow).toContain('test "$SERVER_NAME" = staging-api.dxerp.org.cn');
  });

  it("uses the protected existing SSH secret contract without printing secrets", async () => {
    const workflow = await read(workflowPath);
    for (const name of [
      "DX_REWORK_SSH_HOST",
      "DX_REWORK_SSH_USER",
      "DX_REWORK_SSH_KEY",
      "DX_REWORK_SSH_HOST_KEY",
    ]) {
      expect(workflow).toContain(`secrets.${name}`);
    }
    expect(workflow).toContain("StrictHostKeyChecking=yes");
    expect(workflow).toContain("BatchMode=yes");
    expect(workflow).not.toContain("set -x");
    expect(workflow).not.toContain("ssh-keyscan");
    expect(workflow).not.toContain("scp ");
  });

  it("streams a read-only inspector and never invokes remote mutation controls", async () => {
    const [workflow, script] = await Promise.all([read(workflowPath), read(scriptPath)]);
    expect(workflow).toContain("< scripts/deploy/inspect-shared-host.sh");
    expect(script).toContain("sudo -n nginx -t");
    expect(script).toContain("sudo -n nginx -T");
    for (const forbidden of [
      /nginx\s+-s\s+reload/,
      /systemctl\s+(?:reload|restart|stop|start)/,
      /service\s+nginx\s+(?:reload|restart|stop|start)/,
      /pm2\s+(?:reload|restart|start|stop|delete|kill)/,
      /\bpsql\s+.*-[cfa]\b/,
      /\bpg_dump\s+[^-]/,
      /\bpg_restore\s+[^-]/,
      /sed\s+-i/,
      /\binstall\s+.*\/etc\/nginx/,
      /\bcp\s+.*\/etc\/nginx/,
      /\bmv\s+.*\/etc\/nginx/,
    ]) {
      expect(script).not.toMatch(forbidden);
    }
  });

  it("never dumps application secret values or raw nginx configuration", async () => {
    const script = await read(scriptPath);
    expect(script).not.toContain("cat /opt/dx-rework/shared/.env");
    expect(script).not.toContain("printenv");
    expect(script).not.toMatch(/echo\s+\$DATABASE_URL/);
    expect(script).not.toMatch(/emit\s+.*(?:SESSION_SECRET|OWNER_BOOTSTRAP_SECRET|DINGTALK_H5_APP_SECRET|DINGTALK_WEB_CLIENT_SECRET|OSS_ACCESS_KEY_SECRET)["']?\s+\$?\{/);
    expect(script).toContain("app.key_present.OWNER_BOOTSTRAP_SECRET");
    expect(script).toContain("nginx.target_files");
    expect(script).toContain("nginx.ssl_certificate_paths");
    expect(script).toContain("nginx.rework_locations");
    expect(script).not.toContain("cat \"$nginx_dump\"");
  });

  it("sanitizes PM2 and version output to an explicit allowlist", async () => {
    const script = await read(scriptPath);
    expect(script).toContain('if app.get("name") != "dx-rework-api"');
    expect(script).toContain('"status": env.get("status")');
    expect(script).toContain('"cwd": env.get("pm_cwd")');
    expect(script).toContain('"script": env.get("pm_exec_path") or env.get("script")');
    expect(script).not.toContain('"env": env');
    expect(script).toContain('(\"service\",\"gitSha\",\"expectedSchemaVersion\",\"schemaVersion\",\"ready\")');
  });

  it("has valid shell syntax", () => {
    const result = spawnSync("bash", ["-n", scriptPath], { encoding: "utf8" });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  });
});
