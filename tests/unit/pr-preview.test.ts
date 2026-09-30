import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  assertSafeRemoteDirectory,
  canPublishStatus,
  canReplaceComment,
  commentBody,
  previewBase,
  previewDirectory,
  ROUTES,
} from "../../scripts/preview/lib.mjs";

const exec = promisify(execFile);
const SHA = "0123456789abcdef0123456789abcdef01234567";
const OTHER_SHA = "f".repeat(40);
const DEPLOY = "scripts/preview/remote-deploy.sh";
const CLEANUP = "scripts/preview/remote-cleanup.sh";

async function testRoot() {
  return mkdtemp(path.join(tmpdir(), "dx-rework-preview-test-"));
}

function testEnv(root: string) {
  return { ...process.env, DX_PREVIEW_TEST_MODE: "1", DX_PREVIEW_TEST_ROOT: root };
}

async function prepare(root: string, runId = "100") {
  const result = await exec("bash", [DEPLOY, "prepare", "999", SHA, runId], { env: testEnv(root) });
  return result.stdout.trim();
}

async function writeArtifact(stage: string, runId = "100", headSha = SHA) {
  await writeFile(path.join(stage, "index.html"), "ok");
  await writeFile(path.join(stage, "preview-manifest.json"), JSON.stringify({ headSha, githubRunId: runId }));
}

describe("PR preview", () => {
  it("uses the fixed base and rejects unsafe remote paths", () => {
    expect(previewBase(999)).toBe("/pr-999/");
    expect(previewDirectory(999)).toBe("/opt/dx-rework/previews/pr-999");
    for (const unsafe of ["", "/", "/opt/dx-rework", "/opt/daxing-erp", "/opt/dx-rework/previews/*", "/opt/dx-rework/previews/pr-", "/opt/dx-rework/previews/pr-1/../pr-2"]) {
      expect(() => assertSafeRemoteDirectory(unsafe)).toThrow(/unsafe/);
    }
  });

  it("creates manifest and direct-route fallbacks for the exact Head and run", async () => {
    const dist = await mkdtemp(path.join(tmpdir(), "preview-"));
    await mkdir(path.join(dist, "assets"));
    await writeFile(path.join(dist, "index.html"), '<script src="/pr-999/assets/app.js"></script>');
    await exec("node", ["scripts/preview/build.mjs", "999", SHA, "999999", dist]);
    const data = JSON.parse(await readFile(path.join(dist, "preview-manifest.json"), "utf8"));
    expect(data).toMatchObject({ routeId: "BASE-04", githubPrNumber: 999, headSha: SHA, githubRunId: "999999", buildStatus: "success", basePath: "/pr-999/" });
    for (const route of ROUTES) expect(await readFile(path.join(dist, route, "index.html"), "utf8")).toContain("/pr-999/assets/");
  });

  it("formats every explicit status without inventing a URL", () => {
    const disabled = commentBody({ prNumber: 999, headSha: SHA, runId: "10", state: "built-disabled" });
    const deployed = commentBody({ prNumber: 999, headSha: SHA, runId: "11", state: "deployed", url: "https://preview.example/pr-999/" });
    const failed = commentBody({ prNumber: 999, headSha: SHA, runId: "12", state: "deploy-failed" });
    const cleanupFailed = commentBody({ prNumber: 999, headSha: SHA, runId: "13", state: "cleanup-failed" });
    expect(disabled).toContain("部署未启用");
    expect(deployed).toContain("https://preview.example/pr-999/");
    expect(failed).toContain("部署失败");
    expect(cleanupFailed).toContain("清理失败");
    expect(() => commentBody({ prNumber: 999, headSha: SHA, runId: "14", state: "deploy-failed", url: "https://invalid.example" })).toThrow(/URL/);
  });

  it("allows status publication only for the expected current Head and state", () => {
    const body = commentBody({ prNumber: 999, headSha: SHA, runId: "10", state: "built-disabled" });
    expect(body.match(/dx-rework-pr-preview/g)).toHaveLength(1);
    expect(canReplaceComment(body, SHA)).toBe(true);
    expect(canReplaceComment(body, OTHER_SHA)).toBe(false);
    expect(canPublishStatus({ currentHead: SHA, currentState: "open", expectedHead: SHA, expectedState: "open" })).toBe(true);
    expect(canPublishStatus({ currentHead: OTHER_SHA, currentState: "open", expectedHead: SHA, expectedState: "open" })).toBe(false);
    expect(canPublishStatus({ currentHead: SHA, currentState: "closed", expectedHead: SHA, expectedState: "open" })).toBe(false);
  });

  it("activates a matching artifact and rejects an older generation", async () => {
    const root = await testRoot();
    const first = await prepare(root, "200");
    await writeArtifact(first, "200");
    await exec("bash", [DEPLOY, "activate", "999", SHA, "200", first], { env: testEnv(root) });
    expect(await readFile(path.join(root, "pr-999", ".preview-generation"), "utf8")).toBe(`200 ${SHA}\n`);

    const stale = await prepare(root, "100");
    await writeArtifact(stale, "100");
    await expect(exec("bash", [DEPLOY, "activate", "999", SHA, "100", stale], { env: testEnv(root) })).rejects.toThrow();
    expect(await readFile(path.join(root, "pr-999", ".preview-generation"), "utf8")).toBe(`200 ${SHA}\n`);
  });

  it("rejects target and staging symlinks plus traversal-like staging paths", async () => {
    const root = await testRoot();
    const outside = await mkdtemp(path.join(tmpdir(), "dx-rework-outside-"));
    await symlink(outside, path.join(root, "pr-999"));
    const stage = await prepare(root, "300");
    await writeArtifact(stage, "300");
    await expect(exec("bash", [DEPLOY, "activate", "999", SHA, "300", stage], { env: testEnv(root) })).rejects.toThrow();

    const secondRoot = await testRoot();
    await mkdir(path.join(secondRoot, ".staging"));
    const fakeStage = path.join(secondRoot, ".staging", `pr-999-${SHA}-301.ABC123`);
    await symlink(outside, fakeStage);
    await expect(exec("bash", [DEPLOY, "activate", "999", SHA, "301", fakeStage], { env: testEnv(secondRoot) })).rejects.toThrow();
    await expect(exec("bash", [DEPLOY, "activate", "999", SHA, "301", `${secondRoot}/.staging/../pr-999`], { env: testEnv(secondRoot) })).rejects.toThrow();
  });

  it("cleanup refuses symlinks, a different Head, and a newer active generation", async () => {
    const root = await testRoot();
    const outside = await mkdtemp(path.join(tmpdir(), "dx-rework-outside-"));
    await symlink(outside, path.join(root, "pr-999"));
    await expect(exec("bash", [CLEANUP, "999", SHA, "400"], { env: testEnv(root) })).rejects.toThrow();

    const secondRoot = await testRoot();
    const stage = await prepare(secondRoot, "500");
    await writeArtifact(stage, "500");
    await exec("bash", [DEPLOY, "activate", "999", SHA, "500", stage], { env: testEnv(secondRoot) });
    await expect(exec("bash", [CLEANUP, "999", OTHER_SHA, "600"], { env: testEnv(secondRoot) })).rejects.toThrow();
    await expect(exec("bash", [CLEANUP, "999", SHA, "499"], { env: testEnv(secondRoot) })).rejects.toThrow();
    expect(await readFile(path.join(secondRoot, "pr-999", ".preview-generation"), "utf8")).toBe(`500 ${SHA}\n`);
  });

  it("rejects empty, wildcard and malformed remote inputs", async () => {
    const root = await testRoot();
    for (const args of [[DEPLOY, "prepare", "", SHA, "1"], [DEPLOY, "prepare", "*", SHA, "1"], [DEPLOY, "prepare", "999", "../bad", "1"], [CLEANUP, "999", SHA, "*"]]) {
      await expect(exec("bash", args, { env: testEnv(root) })).rejects.toThrow();
    }
  });
});
