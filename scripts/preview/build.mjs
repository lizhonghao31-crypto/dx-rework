import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
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
const checksum = createHash("sha256").update(index).digest("hex");
await writeFile(path.join(dist, "preview-manifest.json"), `${JSON.stringify(manifest({ prNumber, headSha, runId, checksum }), null, 2)}\n`);
await writeFile(path.join(dist, "SHA256SUMS"), `${checksum}  index.html\n`);
