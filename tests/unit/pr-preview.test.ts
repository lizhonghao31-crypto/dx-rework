import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { assertSafeRemoteDirectory, canReplaceComment, commentBody, previewBase, previewDirectory, ROUTES } from "../../scripts/preview/lib.mjs";
const exec = promisify(execFile);
const SHA = "0123456789abcdef0123456789abcdef01234567";

describe("PR preview", () => {
  it("uses the fixed base and rejects unsafe remote paths", () => {
    expect(previewBase(999)).toBe("/pr-999/");
    expect(previewDirectory(999)).toBe("/opt/dx-rework/previews/pr-999");
    for (const unsafe of ["/", "/opt/dx-rework", "/opt/daxing-erp", "/opt/dx-rework/previews/*", "/opt/dx-rework/previews/pr-"]) expect(() => assertSafeRemoteDirectory(unsafe)).toThrow(/unsafe/);
  });
  it("creates manifest and direct-route fallbacks for the exact Head", async () => {
    const dist = await mkdtemp(path.join(tmpdir(), "preview-"));
    await mkdir(path.join(dist, "assets"));
    await writeFile(path.join(dist, "index.html"), '<script src="/pr-999/assets/app.js"></script>');
    await exec("node", ["scripts/preview/build.mjs", "999", SHA, dist]);
    const data = JSON.parse(await readFile(path.join(dist, "preview-manifest.json"), "utf8"));
    expect(data).toMatchObject({ routeId: "BASE-04", githubPrNumber: 999, headSha: SHA, buildStatus: "success", basePath: "/pr-999/" });
    for (const route of ROUTES) expect(await readFile(path.join(dist, route, "index.html"), "utf8")).toContain("/pr-999/assets/");
  });
  it("upserts one marker and refuses stale Head replacement", () => {
    const body = commentBody({ prNumber: 999, headSha: SHA, state: "built-disabled" });
    expect(body.match(/dx-rework-pr-preview/g)).toHaveLength(1);
    expect(canReplaceComment(body, SHA)).toBe(true);
    expect(canReplaceComment(body, "f".repeat(40))).toBe(false);
    expect(() => commentBody({ prNumber: 999, headSha: SHA, state: "cleaned", url: "https://invalid" })).toThrow();
  });
});
