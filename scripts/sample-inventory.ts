import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { inventorySampleSource } from "../apps/api/src/samples/sample-migration.js";

// Local business-data snapshot only. Never put the resulting directory in git.
// Usage: npx tsx scripts/sample-inventory.ts INPUT.json NEW_OUTPUT_DIRECTORY
// Use --read-legacy-api instead of INPUT.json for the verified legacy read-only endpoint.
const [inputPath, outputPath, ...extra] = process.argv.slice(2);
if (!inputPath || !outputPath || extra.length) throw new Error("Usage: sample-inventory INPUT.json NEW_OUTPUT_DIRECTORY");
async function readInput(): Promise<unknown> {
  if (inputPath !== "--read-legacy-api") return JSON.parse(await readFile(resolve(inputPath!), "utf8"));
  const response = await fetch("https://staging-api.dxerp.org.cn/sample/api/cloud-db", {
    method: "GET", redirect: "error", signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`Legacy read-only inventory failed: HTTP ${response.status}`);
  return response.json();
}
const { source, report } = inventorySampleSource(await readInput());
const directory = resolve(outputPath);
await mkdir(directory, { recursive: false, mode: 0o700 });
await writeFile(join(directory, "source.json"), JSON.stringify(source, null, 2), { flag: "wx", mode: 0o600 });
await writeFile(join(directory, "inventory.json"), JSON.stringify(report, null, 2), { flag: "wx", mode: 0o600 });
process.stdout.write(`${JSON.stringify({ sourceHash: report.sourceHash, samples: report.sampleCount, logs: report.logCount, issues: report.issues.length, readyForImport: false })}\n`);
