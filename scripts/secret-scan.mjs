import { readdir, readFile } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const ignoredDirectories = new Set([".git", "node_modules", "dist", "coverage", "upload"]);
const textExtensions = new Set(["", ".cjs", ".css", ".example", ".html", ".js", ".json", ".md", ".mjs", ".sql", ".ts", ".tsx", ".yml", ".yaml"]);
const signatures = [
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bLTAI[A-Za-z0-9]{12,}\b/,
];

async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignoredDirectories.has(entry.name)) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(path)));
    else if (entry.isFile() && textExtensions.has(extname(entry.name))) files.push(path);
  }
  return files;
}

const findings = [];
for (const path of await walk(root)) {
  const content = await readFile(path, "utf8");
  if (signatures.some((signature) => signature.test(content))) findings.push(relative(root, path));
}

if (findings.length > 0) throw new Error(`Potential secrets detected in: ${findings.join(", ")}`);
process.stdout.write(`${JSON.stringify({ success: true, scannedRoot: "." })}\n`);
