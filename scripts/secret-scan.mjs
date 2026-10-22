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

const quotedSecretAssignment = /\b(?:DINGTALK_H5_APP_SECRET|DINGTALK_WEB_CLIENT_SECRET|SESSION_SECRET|OSS_ACCESS_KEY_SECRET|OPENAI_API_KEY|OWNER_BOOTSTRAP_SECRET|ACCEPTANCE_LAB_SECRET)\b[ \t]*[:=][ \t]*["']([^"'\r\n]{20,})["']/g;
const unquotedSecretAssignment = /\b(?:DINGTALK_H5_APP_SECRET|DINGTALK_WEB_CLIENT_SECRET|SESSION_SECRET|OSS_ACCESS_KEY_SECRET|OPENAI_API_KEY|OWNER_BOOTSTRAP_SECRET|ACCEPTANCE_LAB_SECRET)\b[ \t]*=[ \t]*([A-Za-z0-9_./+=:@-]{20,})/g;

const placeholder = (value) => {
  const normalized = value.toLowerCase();
  if ([
    "replace",
    "example",
    "dummy",
    "fixture",
    "changeme",
    "not-a-secret",
    "acceptance-test",
    "acceptance-lab-secret",
    "abcdefghijklmnopqrstuvwxyz",
    "local-development",
    "production-openai-key",
    "placeholder",
  ].some((marker) => normalized.includes(marker))) return true;

  // Tests and runtime probes use explicit human-readable synthetic values. Keep
  // these distinguishable from pasted random credentials without ignoring test
  // files wholesale, so real provider tokens or random assignments still fail.
  if (/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/i.test(value)
    && /(?:^|[-_])(?:test|gate|probe|synthetic)(?:[-_]|$)/i.test(value)) return true;
  if (/^(?:0123456789abcdef){2,}$/i.test(value)) return true;
  if (/^[0-9]+$/.test(value) && /(?:0123456789|1234567890)/.test(value)) return true;
  return false;
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
  for (const assignment of [quotedSecretAssignment, unquotedSecretAssignment]) {
    assignment.lastIndex = 0;
    for (const match of content.matchAll(assignment)) {
      const value = match[1] ?? "";
      if (!placeholder(value)) return true;
    }
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

const historicalAssignmentRegex = [
  "DINGTALK_H5_APP_SECRET",
  "DINGTALK_WEB_CLIENT_SECRET",
  "SESSION_SECRET",
  "OSS_ACCESS_KEY_SECRET",
  "OPENAI_API_KEY",
  "OWNER_BOOTSTRAP_SECRET",
  "ACCEPTANCE_LAB_SECRET",
].map((name) => `${name}[[:space:]]*[:=]`).join("|");

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

  // Git -G is a broad POSIX candidate filter. Verify changed content with the
  // same bounded detector used for worktree/artifacts before reporting a leak.
  const signatureDiff = runGit(root, [
    "log", "--all", "--extended-regexp", "-G", historicalSecretRegex,
    "--format=@@COMMIT:%H", "--no-renames", "--no-ext-diff", "--unified=0", "--patch",
  ]);
  const signatureFindings = [];
  let currentCommit = "unknown";
  let currentPath = "unknown";
  for (const raw of signatureDiff.split("\n")) {
    if (raw.startsWith("@@COMMIT:")) {
      currentCommit=raw.slice("@@COMMIT:".length).trim().slice(0,12);
      currentPath="unknown";
    } else if (raw.startsWith("--- a/") || raw.startsWith("+++ b/")) {
      currentPath=raw.slice(6).trim();
    } else if ((raw.startsWith("+") || raw.startsWith("-"))
      && !raw.startsWith("+++") && !raw.startsWith("---") && containsSecretSignature(raw.slice(1))) {
      signatureFindings.push(`${currentCommit}:${currentPath}`);
    }
  }

  const assignmentDiff = runGit(root, [
    "log",
    "--all",
    "--extended-regexp",
    "-G",
    historicalAssignmentRegex,
    "--format=@@COMMIT:%H",
    "--no-renames",
    "--no-ext-diff",
    "--unified=0",
    "--patch",
  ]);

  const assignmentFindings = [];
  let assignmentCommit = "unknown";
  let assignmentPath = "unknown";
  for (const raw of assignmentDiff.split("\n")) {
    if (raw.startsWith("@@COMMIT:")) {
      assignmentCommit = raw.slice("@@COMMIT:".length).trim().slice(0, 12) || "unknown";
      assignmentPath = "unknown";
      continue;
    }
    if (raw.startsWith("--- a/")) {
      assignmentPath = raw.slice("--- a/".length).trim();
      continue;
    }
    if (raw.startsWith("+++ b/")) {
      assignmentPath = raw.slice("+++ b/".length).trim();
      continue;
    }
    if ((raw.startsWith("+") || raw.startsWith("-"))
      && !raw.startsWith("+++")
      && !raw.startsWith("---")
      && containsSecretSignature(raw.slice(1))) {
      assignmentFindings.push(`${assignmentCommit}:${assignmentPath}`);
    }
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
    signatures: [...new Set([...signatureFindings, ...assignmentFindings])].sort(),
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
