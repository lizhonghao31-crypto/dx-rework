import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { manifest, ROUTES, routeArtifactPath } from "./lib.mjs";

const [prNumber, headSha, dist = "apps/web/dist"] = process.argv.slice(2);
if (!prNumber || !headSha) throw new Error("usage: build.mjs <pr-number> <full-head-sha> [dist]");
const index = await readFile(path.join(dist, "index.html"));
for (const route of ROUTES) {
  const target = routeArtifactPath(dist, route);
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(path.join(dist, "index.html"), target);
}
const checksum = createHash("sha256").update(index).digest("hex");
await writeFile(path.join(dist, "preview-manifest.json"), `${JSON.stringify(manifest({ prNumber, headSha, checksum }), null, 2)}\n`);
await writeFile(path.join(dist, "SHA256SUMS"), `${checksum}  index.html\n`);
