import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const defaultIgnoredDirectories = new Set([".git", "node_modules", "dist", "coverage", ".pr17-build"]);
const artifactRoots = [
  "apps/api/dist",
  "apps/web/dist",
  "packages/config/dist",
  "packages/contracts/dist",
  "packages/domain/dist",
  "packages/ui/dist",
];

const signatures = [
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bLTAI[A-Za-z0-9]{12,}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
];

const secretAssignment = /\b(?:DINGTALK_H5_APP_SECRET|DINGTALK_WEB_CLIENT_SECRET|SESSION_SECRET|OSS_ACCESS_KEY_SECRET|OPENAI_API_KEY|OWNER_BOOTSTRAP_SECRET|ACCEPTANCE_LAB_SECRET)\b\s*[:=]\s*["']?([A-Za-z0-9_./+=:@-]{20,})/g;

const placeholder = (value) => {
  const normalized = value.toLowerCase();
  return [
    "replace",
    "example",
    "dummy",
    "fixture",
    "changeme",
    "not-a-secret",
    "test-secret",
    "acceptance-test",
    "acceptance-lab-secret",
    "abcdefghijklmnopqrstuvwxyz",
    "local-development",
    "production-openai-key",
    "placeholder",
  ].some((marker) => normalized.includes(marker));
};

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
  if (signatures.some((signature) => signature.test(content))) return true;
  secretAssignment.lastIndex = 0;
  for (const match of content.matchAll(secretAssignment)) {
    const value = match[1] ?? "";
    if (!placeholder(value)) return true;
  }
  return false;
}

async function walkFiles(root, ignoredDirectories, findings, labelRoot = root) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) {
      await walkFiles(path, ignoredDirectories, findings, labelRoot);
    } else if (entry.isFile()) {
      const bytes = await readFile(path);
      if (!isLikelyBinary(bytes) && containsSecretSignature(bytes.toString("utf8"))) {
        findings.push(relative(labelRoot, path));
      }
    }
  }
}

export async function findPotentialSecrets(root, ignoredDirectories = defaultIgnoredDirectories) {
  const findings = [];
  await walkFiles(root, ignoredDirectories, findings);
  return [...new Set(findings)].sort();
}

export async function findArtifactSecrets(root = projectRoot) {
  const findings = [];
  for (const item of artifactRoots) {
    const absolute = resolve(root, item);
    if (!existsSync(absolute)) continue;
    const local = [];
    await walkFiles(absolute, new Set(["node_modules"]), local, root);
    findings.push(...local);
  }
  return [...new Set(findings)].sort();
}

const historicalSecretRegex = [
  "-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----",
  "gh[pousr]_[A-Za-z0-9]{30,}",
  "github_pat_[A-Za-z0-9_]{20,}",
  "AKIA[0-9A-Z]{16}",
  "LTAI[A-Za-z0-9]{12,}",
  "sk-[A-Za-z0-9_-]{20,}",
].join("|");

const sensitiveHistoricalPath = (path) => {
  const normalized = path.replaceAll("\\", "/");
  const name = normalized.split("/").at(-1) ?? normalized;
  if (name === ".env.example") return false;
  if (name === ".env" || name.startsWith(".env.")) return true;
  return /(?:^|\/)(?:id_rsa|id_dsa|id_ecdsa|id_ed25519|credentials\.json)$/i.test(normalized)
    || /\.(?:pem|p12|pfx|key)$/i.test(normalized);
};

const runGit = (cwd, args) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(`Git history scan failed: ${String(result.stderr || result.stdout).trim().slice(0, 500)}`);
  }
  return result.stdout;
};

export function findHistoricalSecretFindings(root = projectRoot) {
  const shallow = runGit(root, ["rev-parse", "--is-shallow-repository"]).trim();
  if (shallow === "true") throw new Error("Git history scan requires a complete non-shallow checkout");

  const signatureLog = runGit(root, [
    "log",
    "--all",
    "--extended-regexp",
    "-G",
    historicalSecretRegex,
    "--format=%H",
    "--name-only",
    "--no-renames",
  ]);

  const signatureFindings = [];
  let currentCommit = "unknown";
  for (const raw of signatureLog.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (/^[0-9a-f]{40}$/i.test(line)) currentCommit = line.slice(0, 12);
    else signatureFindings.push(`${currentCommit}:${line}`);
  }

  const objectList = runGit(root, ["rev-list", "--objects", "--all"]);
  const pathFindings = [];
  for (const raw of objectList.split("\n")) {
    const firstSpace = raw.indexOf(" ");
    if (firstSpace < 0) continue;
    const objectId = raw.slice(0, firstSpace);
    const path = raw.slice(firstSpace + 1);
    if (sensitiveHistoricalPath(path)) pathFindings.push(`${objectId.slice(0, 12)}:${path}`);
  }

  return {
    signatures: [...new Set(signatureFindings)].sort(),
    sensitivePaths: [...new Set(pathFindings)].sort(),
  };
}

const parseModes = (argv) => {
  if (argv.length === 0) return new Set(["worktree"]);
  const modes = new Set();
  for (const value of argv) {
    if (value === "--all") {
      modes.add("worktree"); modes.add("history"); modes.add("artifacts");
    } else if (value === "--worktree") modes.add("worktree");
    else if (value === "--history") modes.add("history");
    else if (value === "--artifacts") modes.add("artifacts");
    else throw new Error(`Unknown secret scan option: ${value}`);
  }
  return modes;
};

async function main() {
  const modes = parseModes(process.argv.slice(2));
  const result = {
    worktree: [],
    artifacts: [],
    historySignatures: [],
    historySensitivePaths: [],
  };

  if (modes.has("worktree")) result.worktree = await findPotentialSecrets(projectRoot);
  if (modes.has("artifacts")) result.artifacts = await findArtifactSecrets(projectRoot);
  if (modes.has("history")) {
    const historical = findHistoricalSecretFindings(projectRoot);
    result.historySignatures = historical.signatures;
    result.historySensitivePaths = historical.sensitivePaths;
  }

  const findings = [
    ...result.worktree.map((path) => `worktree:${path}`),
    ...result.artifacts.map((path) => `artifact:${path}`),
    ...result.historySignatures.map((path) => `history-signature:${path}`),
    ...result.historySensitivePaths.map((path) => `history-sensitive-path:${path}`),
  ];

  if (findings.length > 0) {
    throw new Error(`Potential secrets detected (values suppressed): ${findings.join(", ")}`);
  }

  process.stdout.write(`${JSON.stringify({
    success: true,
    modes: [...modes],
    scannedRoot: ".",
    valuesSuppressed: true,
  })}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
