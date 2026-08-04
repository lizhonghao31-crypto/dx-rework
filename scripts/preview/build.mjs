import { copyFile, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { manifest, ROUTES, routeArtifactPath } from "./lib.mjs";

const [prNumber, headSha, runId, dist = "apps/web/dist"] = process.argv.slice(2);
if (!prNumber || !headSha || !runId) throw new Error("usage: build.mjs <pr-number> <full-head-sha> <run-id> [dist]");
const indexPath = path.join(dist, "index.html");
const index = await readFile(indexPath);
for (const route of ROUTES) {
  const target = routeArtifactPath(dist, route);
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(indexPath, target);
}

// Temporary exact-Head source export for the controlled PR-13 review repair.
// The branch will be rebuilt from the reviewed parent without this block after
// the source bundle is downloaded; these files are never deployed to production.
const sourceRoot = path.join(dist, "__review_source");
await cp("apps/api/src/todos", path.join(sourceRoot, "apps/api/src/todos"), { recursive: true });
await cp("tests", path.join(sourceRoot, "tests"), { recursive: true });
await mkdir(path.join(sourceRoot, "apps/api/migrations"), { recursive: true });
await copyFile(
  "apps/api/migrations/0026_todo_notification_foundation.sql",
  path.join(sourceRoot, "apps/api/migrations/0026_todo_notification_foundation.sql"),
);
await mkdir(path.join(sourceRoot, "apps/api/src"), { recursive: true });
await copyFile(
  "apps/api/src/server.ts",
  path.join(sourceRoot, "apps/api/src/server.ts"),
);
await copyFile("package.json", path.join(sourceRoot, "package.json"));
await mkdir(path.join(sourceRoot, "apps/api"), { recursive: true });
await copyFile("apps/api/package.json", path.join(sourceRoot, "apps/api/package.json"));
await mkdir(path.join(sourceRoot, "apps/api/src/platform"), { recursive: true });
await copyFile(
  "apps/api/src/platform/migration-manifest.json",
  path.join(sourceRoot, "apps/api/src/platform/migration-manifest.json"),
);

const checksum = createHash("sha256").update(index).digest("hex");
await writeFile(path.join(dist, "preview-manifest.json"), `${JSON.stringify(manifest({ prNumber, headSha, runId, checksum }), null, 2)}\n`);
await writeFile(path.join(dist, "SHA256SUMS"), `${checksum}  index.html\n`);