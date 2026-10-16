import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const sha = "0123456789abcdef0123456789abcdef01234567";
const bash = (script: string, env: Record<string, string> = {}) =>
  spawnSync("bash", ["-c", script], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
const matrix = () => JSON.parse(readFileSync("docs/operations/pr-17-acceptance-matrix.json", "utf8"));
type Matrix = { items: Array<Record<string, unknown>> };
const validate = (mutate: (value: Matrix) => void) => {
  const value = matrix() as Matrix;
  mutate(value);
  const directory = mkdtempSync(join(tmpdir(), "uat-"));
  const path = join(directory, "m.json");
  writeFileSync(path, JSON.stringify(value));
  return spawnSync("node", ["scripts/acceptance/validate.mjs", path], { cwd: root });
};

function startApiTestEnv(path: string): Record<string, string> {
  return {
    DX_REWORK_TEST_MODE: "true",
    DX_REWORK_TEST_ENV_FILE: path,
    DX_REWORK_TEST_NODE: process.execPath,
  };
}

function transferFixture(): { directory: string; bundle: string } {
  const directory = mkdtempSync(join(tmpdir(), "transfer-"));
  const bundle = join(directory, sha);
  for (const kind of ["api", "frontend"]) {
    mkdirSync(join(bundle, kind), { recursive: true });
    writeFileSync(join(bundle, kind, "release-manifest.json"), JSON.stringify({ gitSha: sha }));
    bash(`cd '${join(bundle, kind)}'; sha256sum release-manifest.json > SHA256SUMS`);
  }
  writeFileSync(join(bundle, "release-manifest.json"), JSON.stringify({ gitSha: sha }));
  bash(`cd '${bundle}'; sha256sum release-manifest.json > SHA256SUMS`);
  return { directory, bundle };
}

describe("PR-17 executable release lifecycle", () => {
  it("creates a relocation-safe checksum for an absolute transfer output", () => {
    const { directory, bundle } = transferFixture();
    const artifactDirectory = join(directory, "artifacts");
    const output = join(artifactDirectory, "release.tar.gz");
    mkdirSync(artifactDirectory);
    expect(bash(`scripts/deploy/create-transfer-bundle.sh '${bundle}' '${output}'`).status).toBe(0);
    expect(bash(`cd '${artifactDirectory}'; sha256sum -c --strict release.tar.gz.sha256`).status).toBe(0);
  });

  it("does not reject an ordinary dependency filename containing key", () => {
    const { directory, bundle } = transferFixture();
    const output = join(directory, "release.tar.gz");
    writeFileSync(join(bundle, "api", "keyboard.js"), "export default 'normal dependency'\n");
    bash(`cd '${join(bundle, "api")}'; sha256sum release-manifest.json keyboard.js > SHA256SUMS`);
    expect(bash(`scripts/deploy/create-transfer-bundle.sh '${bundle}' '${output}'`).status).toBe(0);
  });

  it("rejects actual sensitive transfer inputs", () => {
    const { directory, bundle } = transferFixture();
    writeFileSync(join(bundle, "api", "client.key"), "not-a-real-key");
    expect(
      bash(`scripts/deploy/create-transfer-bundle.sh '${bundle}' '${join(directory, "release.tar.gz")}'`).status,
    ).not.toBe(0);
  });

  it("renders a real TLS vhost without placeholders", () => {
    const directory = mkdtempSync(join(tmpdir(), "nginx-"));
    const cert = join(directory, "cert");
    const key = join(directory, "key");
    const output = join(directory, "out");
    writeFileSync(cert, "cert");
    writeFileSync(key, "key");
    expect(
      bash(`scripts/deploy/render-nginx.sh infra/nginx/dx-rework.conf.example '${output}'`, {
        DX_REWORK_SERVER_NAME: "rework.example.test",
        DX_REWORK_TLS_CERT: cert,
        DX_REWORK_TLS_KEY: key,
      }).status,
    ).toBe(0);
    const rendered = readFileSync(output, "utf8");
    expect(rendered).toContain("listen 443 ssl");
    expect(rendered).not.toMatch(/__[A-Z_]+__/);
  });

  it("renderer rejects the known mixed ERP vhost", () => {
    const directory = mkdtempSync(join(tmpdir(), "nginx-"));
    const cert = join(directory, "cert");
    const key = join(directory, "key");
    writeFileSync(cert, "");
    writeFileSync(key, "");
    expect(
      bash(`scripts/deploy/render-nginx.sh infra/nginx/dx-rework.conf.example '${join(directory, "out")}'`, {
        DX_REWORK_SERVER_NAME: "staging-api.dxerp.org.cn",
        DX_REWORK_TLS_CERT: cert,
        DX_REWORK_TLS_KEY: key,
      }).status,
    ).not.toBe(0);
  });

  it("strict env parser rejects shell syntax instead of evaluating it", () => {
    const directory = mkdtempSync(join(tmpdir(), "env-"));
    const envFile = join(directory, "env");
    const marker = join(directory, "owned");
    writeFileSync(envFile, `BAD=$(touch ${marker})\n`);
    chmodSync(envFile, 0o600);
    expect(bash("scripts/deploy/start-api.sh", startApiTestEnv(envFile)).status).not.toBe(0);
    expect(bash(`test ! -e '${marker}'`).status).toBe(0);
  });

  it("start wrapper rejects symlink environment files", () => {
    const directory = mkdtempSync(join(tmpdir(), "env-"));
    const envFile = join(directory, "env");
    const link = join(directory, "link");
    writeFileSync(envFile, "DATABASE_URL=postgresql://fixture/fixture\n");
    bash(`ln -s '${envFile}' '${link}'`);
    expect(bash("scripts/deploy/start-api.sh", startApiTestEnv(link)).status).not.toBe(0);
  });

  it("start wrapper rejects permissive environment mode", () => {
    const envFile = join(mkdtempSync(join(tmpdir(), "env-")), "env");
    writeFileSync(envFile, "DATABASE_URL=postgresql://fixture/fixture\n");
    chmodSync(envFile, 0o644);
    expect(bash("scripts/deploy/start-api.sh", startApiTestEnv(envFile)).status).not.toBe(0);
  });

  it("install separates API and frontend payloads", () => {
    const directory = mkdtempSync(join(tmpdir(), "install-"));
    const bundle = join(directory, "bundle");
    const deploymentRoot = join(directory, "dx");
    for (const kind of ["api", "frontend"]) {
      mkdirSync(join(bundle, kind), { recursive: true });
      writeFileSync(join(bundle, kind, "release-manifest.json"), JSON.stringify({ gitSha: sha }));
      writeFileSync(join(bundle, kind, kind === "frontend" ? "index.html" : kind), kind);
      bash(`cd '${join(bundle, kind)}'; sha256sum release-manifest.json '${kind === "frontend" ? "index.html" : kind}' > SHA256SUMS`);
    }
    expect(
      bash(`scripts/deploy/install-release.sh '${sha}' '${bundle}'`, { DX_REWORK_ROOT: deploymentRoot }).status,
    ).toBe(0);
    expect(readFileSync(join(deploymentRoot, "releases", sha, "api"), "utf8")).toBe("api");
    expect(readFileSync(join(deploymentRoot, "frontend", "releases", sha, "index.html"), "utf8")).toBe(
      "frontend",
    );
  });

  it("install is idempotent for identical content", () => {
    const directory = mkdtempSync(join(tmpdir(), "install-"));
    const bundle = join(directory, "bundle");
    const deploymentRoot = join(directory, "dx");
    for (const kind of ["api", "frontend"]) {
      mkdirSync(join(bundle, kind), { recursive: true });
      writeFileSync(join(bundle, kind, "release-manifest.json"), JSON.stringify({ gitSha: sha }));
      if (kind === "frontend") writeFileSync(join(bundle, kind, "index.html"), "synthetic frontend");
      bash(`cd '${join(bundle, kind)}'; sha256sum release-manifest.json ${kind === "frontend" ? "index.html" : ""} > SHA256SUMS`);
    }
    expect(
      bash(
        `scripts/deploy/install-release.sh '${sha}' '${bundle}' && scripts/deploy/install-release.sh '${sha}' '${bundle}'`,
        { DX_REWORK_ROOT: deploymentRoot },
      ).status,
    ).toBe(0);
  });

  it("install rejects changed immutable content", () => {
    const directory = mkdtempSync(join(tmpdir(), "install-"));
    const bundle = join(directory, "bundle");
    const deploymentRoot = join(directory, "dx");
    for (const kind of ["api", "frontend"]) {
      mkdirSync(join(bundle, kind), { recursive: true });
      writeFileSync(join(bundle, kind, "release-manifest.json"), JSON.stringify({ gitSha: sha }));
      if (kind === "frontend") writeFileSync(join(bundle, kind, "index.html"), "synthetic frontend");
      bash(`cd '${join(bundle, kind)}'; sha256sum release-manifest.json ${kind === "frontend" ? "index.html" : ""} > SHA256SUMS`);
    }
    expect(
      bash(`scripts/deploy/install-release.sh '${sha}' '${bundle}'`, { DX_REWORK_ROOT: deploymentRoot }).status,
    ).toBe(0);
    writeFileSync(join(bundle, "api", "extra"), "changed");
    expect(
      bash(`scripts/deploy/install-release.sh '${sha}' '${bundle}'`, { DX_REWORK_ROOT: deploymentRoot }).status,
    ).not.toBe(0);
  });

  it("validator rejects exact requirement drift", () => {
    expect(validate((value) => (value.items[3].requirement = "drift")).status).not.toBe(0);
  });

  it("validator rejects failed UAT without defect", () => {
    expect(
      validate((value) =>
        Object.assign(value.items[0], {
          result: "failed",
          gitSha: sha,
          schemaVersion: "0032_x",
          executedAt: new Date().toISOString(),
          environment: "isolated",
          testDataIds: ["x"],
          roles: ["worker"],
          steps: ["run"],
          expected: "ok",
          actual: "failed",
          executor: "a",
          reviewer: "b",
          evidenceRefs: ["e"],
        }),
      ).status,
    ).not.toBe(0);
  });

  it("validator rejects blocked UAT without evidence or dependency", () => {
    expect(
      validate((value) =>
        Object.assign(value.items[0], {
          result: "blocked",
          gitSha: sha,
          schemaVersion: "0032_x",
          executedAt: new Date().toISOString(),
          environment: "isolated",
          testDataIds: ["x"],
          roles: ["worker"],
          steps: ["run"],
          expected: "ok",
          actual: "dependency unavailable",
          executor: "a",
          reviewer: "b",
        }),
      ).status,
    ).not.toBe(0);
  });

  it("workflow binds deploy to downloaded gate bundle", () => {
    const workflow = readFileSync(".github/workflows/pr-17-release.yml", "utf8");
    expect(workflow).toContain("actions/download-artifact");
    expect(workflow).toContain("sha256sum -c --strict");
    expect(workflow).not.toContain("/opt/dx-rework/tools/");
  });

  it("workflow authorizes only exact origin main head", () => {
    const workflow = readFileSync(".github/workflows/pr-17-release.yml", "utf8");
    expect(workflow).toContain('test "$(git rev-parse origin/main)" = "$TARGET_SHA"');
    expect(workflow).not.toContain("merge-base --is-ancestor");
  });

  it("workflow refreshes main exactly and applies only with explicit migration input", () => {
    const workflow = readFileSync(".github/workflows/pr-17-release.yml", "utf8");
    expect(workflow).toContain("+refs/heads/main:refs/remotes/origin/main");
    expect(workflow).toContain("apply_migrations");
    expect(workflow).toContain("DX_REWORK_APPLY=true");
  });

  it("roadmap uses exact merged PR numbers", () => {
    const roadmap = readFileSync("docs/plan/pr-roadmap-v2.0.md", "utf8");
    expect(roadmap).toMatch(/\| PR-13 \|.*GitHub #22/);
    expect(roadmap).toMatch(/\| PR-15 \|.*GitHub #25/);
  });
});
