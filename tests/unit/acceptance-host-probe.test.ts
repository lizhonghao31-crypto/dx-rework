import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Acceptance staging host probe", () => {
  it("is manual, pilot-scoped and read-only on the remote host", async () => {
    const workflow = await readFile(".github/workflows/acceptance-host-probe.yml", "utf8");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).not.toMatch(/^\s+(push|pull_request):/m);
    expect(workflow).toContain("environment: dx-rework-acceptance");
    expect(workflow).toContain("StrictHostKeyChecking=yes");

    const start = workflow.indexOf("<<'REMOTE'");
    const end = workflow.indexOf("\n          REMOTE", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const remote = workflow.slice(start, end);

    for (const forbidden of [
      /\bsudo\b/,
      /\brm\b/,
      /\bmv\b/,
      /\bmkdir\b/,
      /\btouch\b/,
      /\bchmod\b/,
      /\bchown\b/,
      /\bsystemctl\b/,
      /\bservice\b/,
      /\bcreatedb\b/,
      /\bdropdb\b/,
      /\bpsql\b/,
      /pm2\s+(?:start|restart|reload|delete|stop)/,
    ]) {
      expect(remote).not.toMatch(forbidden);
    }
  });

  it("reports only non-secret Acceptance facts and legacy public reachability", async () => {
    const workflow = await readFile(".github/workflows/acceptance-host-probe.yml", "utf8");
    expect(workflow).toContain("/opt/dx-rework-acceptance");
    expect(workflow).toContain("127.0.0.1:3202");
    expect(workflow).toContain("staging-api.dxerp.org.cn/acceptance");
    expect(workflow).toContain("/api/health/ready");
    expect(workflow).toContain("/api/version");
    expect(workflow).toContain("acceptance_database_configured");
    expect(workflow).not.toContain("DX_REWORK_ACCEPTANCE_PUBLIC_URL");
    expect(workflow).not.toContain("ACCEPTANCE_LAB_SECRET");
    expect(workflow).not.toContain("SESSION_SECRET");
  });
});
