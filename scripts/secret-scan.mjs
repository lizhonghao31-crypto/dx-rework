import { readFile, readdir } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const defaultIgnoredDirectories = new Set([".git", "node_modules", "dist", "coverage", "upload"]);
const signatures = [
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bLTAI[A-Za-z0-9]{12,}\b/,
];

export function isLikelyBinary(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8_192));
  if (sample.includes(0)) return true;
  let controlBytes = 0;
  for (const byte of sample) {
    const isTextWhitespace = byte === 9 || byte === 10 || byte === 13;
    if (!isTextWhitespace && (byte < 32 || byte === 127)) controlBytes += 1;
  }
  return sample.length > 0 && controlBytes / sample.length > 0.2;
}

export function containsSecretSignature(content) {
  return signatures.some((signature) => signature.test(content));
}

export async function findPotentialSecrets(root, ignoredDirectories = defaultIgnoredDirectories) {
  const findings = [];

  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile()) {
        const bytes = await readFile(path);
        if (!isLikelyBinary(bytes) && containsSecretSignature(bytes.toString("utf8"))) {
          findings.push(relative(root, path));
        }
      }
    }
  }

  await walk(root);
  return findings.sort();
}

async function main() {
  const findings = await findPotentialSecrets(projectRoot);
  if (findings.length > 0) throw new Error(`Potential secrets detected in: ${findings.join(", ")}`);
  process.stdout.write(`${JSON.stringify({ success: true, scannedRoot: ".", mode: "all-non-binary-files" })}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
