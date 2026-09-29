import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

describe("isolated Acceptance deployment contract", () => {
  it("keeps Acceptance deployment on a dedicated root, process and port", () => {
    const start = read("scripts/deploy/start-acceptance-api.sh");
    const remote = read("scripts/deploy/acceptance-remote-release.sh");
    const pm2 = read("infra/pm2/ecosystem.acceptance.config.cjs");
    expect(start).toContain("/opt/dx-rework-acceptance");
    expect(start).toContain("NODE_ENV=test");
    expect(start).toContain("PORT=3202");
    expect(start).toContain("SERVICE_NAME=dx-rework-acceptance-api");
    expect(pm2).toContain('name: "dx-rework-acceptance-api"');
    expect(pm2).toContain("/opt/dx-rework-acceptance");
    expect(remote).toContain('DX_ROOT="/opt/dx-rework-acceptance"');
    expect(remote).not.toContain('DX_ROOT="/opt/dx-rework"');
  });

  it("fails closed before touching a non-Acceptance database or external side effects", () => {
    const remote = read("scripts/deploy/acceptance-remote-release.sh");
    const start = read("scripts/deploy/start-acceptance-api.sh");
    expect(remote.indexOf("assert_acceptance_database")).toBeLessThan(remote.indexOf('migrate.mjs'));
    expect(remote).toContain("(acceptance|uat|test)");
    for (const source of [remote, start]) {
      expect(source).toContain("TODO_RUNTIME_ENABLED");
      expect(source).toContain("TODO_DELIVERY_ENABLED");
      expect(source).toContain("TODO_TIMING_ENABLED");
      expect(source).toContain("OSS_BUCKET");
      expect(source).toContain("OPENAI_API_KEY");
    }
  });

  it("uses a protected manual workflow that may deploy an exact candidate SHA without production secrets", () => {
    const workflow = read(".github/workflows/acceptance-release.yml");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).not.toMatch(/^\s+(push|pull_request):/m);
    expect(workflow).toContain("environment: dx-rework-acceptance");
    expect(workflow).toContain("Exact repository commit SHA");
    expect(workflow).toContain("/opt/dx-rework-acceptance");
    expect(workflow).toContain("DX_REWORK_ACCEPTANCE_PUBLIC_URL");
    expect(workflow).not.toContain("environment: dx-rework-production");
    expect(workflow).toContain('[[ "$ACCEPTANCE_PUBLIC_URL" != https://dxerp.org.cn* ]]');
  });

  it("checks out complete history before the full secret scan", () => {
    const workflow = read(".github/workflows/acceptance-release.yml");
    const checkoutStart = workflow.indexOf("- name: Checkout exact candidate");
    const checkoutEnd = workflow.indexOf("- name: Verify exact candidate");
    const gateCheckout = workflow.slice(checkoutStart, checkoutEnd);
    expect(gateCheckout).toContain("fetch-depth: 0");
    expect(workflow.indexOf("Checkout exact candidate")).toBeLessThan(workflow.indexOf("npm run secret:scan:full"));
  });

  it("loads Acceptance-only secrets through the guarded app env allowlist", () => {
    const lib = read("scripts/deploy/lib.sh");
    expect(lib).toContain("ACCEPTANCE_LAB_ENABLED");
    expect(lib).toContain("ACCEPTANCE_LAB_SECRET");
    const start = read("scripts/deploy/start-acceptance-api.sh");
    expect(start.indexOf("load_app_config")).toBeLessThan(start.indexOf("ACCEPTANCE_LAB_ENABLED"));
  });

  it("mints one-time control credentials only from the isolated runtime", () => {
    const mint = read("scripts/deploy/mint-acceptance-control-code.sh");
    expect(mint).toContain("/opt/dx-rework-acceptance");
    expect(mint).toContain("mintAcceptanceControlCode");
    expect(mint).toContain("ACCEPTANCE_LAB_SECRET");
    expect(mint).not.toContain("/opt/dx-rework/current");
  });

  it("seeds only deterministic digital-production roots into an Acceptance database", () => {
    const seed = read("scripts/deploy/seed-acceptance-production-fixtures.sh");
    expect(seed).toContain("select current_database()");
    expect(seed).toContain("(acceptance|accept|uat|test)");
    expect(seed).toContain("production_order_roots");
    expect(seed).toContain("digital_production_v1");
    expect(seed).toContain("ON CONFLICT(production_order_id) DO NOTHING");
    expect(seed).not.toContain("sourcing_cases");
    expect(seed).not.toContain("rework_orders");
  });

  it("runs live browser role regression and uploads exact-SHA evidence after a real Acceptance deploy", () => {
    const workflow = read(".github/workflows/acceptance-release.yml");
    const browser = read("scripts/acceptance/live-browser-regression.mjs");
    expect(workflow).toContain("Install pinned Chromium regression runner");
    expect(workflow).toContain("mint-acceptance-control-code.sh");
    expect(workflow).toContain("seed-acceptance-production-fixtures.sh");
    expect(workflow).toContain("acceptance-validation-${{ inputs.git_sha }}");
    expect(workflow).toContain("candidate-lock.json");
    expect(browser).toContain("运行全部角色权限矩阵");
    expect(browser).toContain("[UAT] Root");
    expect(browser).toContain("Acceptance approved matrix has failures");
    expect(browser).toContain("dxerp.org.cn");
    expect(browser).not.toContain("ACCEPTANCE_LAB_SECRET");
  });

  it("provides an Acceptance-only nginx template and safe configuration examples", () => {
    const nginx = read("infra/nginx/dx-rework-acceptance.conf.example");
    const app = read("infra/acceptance/app.env.example");
    expect(nginx).toContain("/opt/dx-rework-acceptance/frontend/current");
    expect(nginx).toContain("127.0.0.1:3202");
    expect(nginx).not.toContain("127.0.0.1:3201");
    expect(app).toContain("dx_rework_acceptance");
    expect(app).toContain("ROOT_DINGTALK_USER_ID=uat-root");
    expect(app).toContain("ACCEPTANCE_LAB_ENABLED=true");
    expect(app).toContain("TODO_RUNTIME_ENABLED=false");
    expect(app).not.toContain("OSS_BUCKET=");
    expect(app).not.toContain("OPENAI_API_KEY=");
  });
});
