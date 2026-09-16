#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import ts from "typescript";

const repoRoot = resolve(process.cwd());
const arg = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};
const outDir = resolve(repoRoot, arg("--out", ".audit/codebase-governance"));
const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);
const DUP_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".css", ".sql"]);
const IGNORE_PREFIXES = ["node_modules/", "dist/", "coverage/", ".git/", ".audit/"];
const DECISION_LOGICAL = new Set([
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken,
]);

const runGit = (args) => execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const trackedFiles = runGit(["ls-files", "-z"])
  .split("\0")
  .filter(Boolean)
  .filter((path) => !IGNORE_PREFIXES.some((prefix) => path.startsWith(prefix)));
const trackedSet = new Set(trackedFiles);
const sha = runGit(["rev-parse", "HEAD"]).trim();
const branch = (() => {
  try { return runGit(["rev-parse", "--abbrev-ref", "HEAD"]).trim(); }
  catch { return "unknown"; }
})();

const classify = (path) => {
  if (path.startsWith("tests/")) return "tests";
  if (path.startsWith("apps/api/migrations/")) return "migrations";
  if (path.startsWith("apps/api/src/")) return "api-runtime";
  if (path.startsWith("apps/web/src/")) return "web-runtime";
  if (path.startsWith("packages/")) return "packages";
  if (path.startsWith("scripts/")) return "scripts";
  if (path.endsWith(".css")) return "styles";
  if (path.startsWith(".github/")) return "github";
  return "other";
};

const isGeneratedLike = (path) => /(^|\/)(dist|coverage|node_modules)(\/|$)/.test(path)
  || /package-lock\.json$/.test(path)
  || /\.snap$/.test(path);

const lineStats = (text) => {
  const lines = text.split(/\r?\n/);
  let nonblank = 0;
  let comments = 0;
  let inBlock = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    nonblank += 1;
    if (inBlock) {
      comments += 1;
      if (line.includes("*/")) inBlock = false;
      continue;
    }
    if (line.startsWith("//") || line.startsWith("#")) comments += 1;
    if (line.startsWith("/*")) {
      comments += 1;
      if (!line.includes("*/", 2)) inBlock = true;
    }
  }
  return { lines: lines.length, nonblank, codeApprox: Math.max(0, nonblank - comments) };
};

const scriptKind = (path) => path.endsWith(".tsx") ? ts.ScriptKind.TSX
  : path.endsWith(".ts") ? ts.ScriptKind.TS
  : path.endsWith(".jsx") ? ts.ScriptKind.JSX
  : ts.ScriptKind.JS;

const functionName = (node, source) => {
  if (node.name && ts.isIdentifier(node.name)) return node.name.text;
  const parent = node.parent;
  if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  if (parent && ts.isPropertyAssignment(parent)) return parent.name.getText(source).slice(0, 80);
  if (ts.isMethodDeclaration(node) && node.name) return node.name.getText(source).slice(0, 80);
  return "<anonymous>";
};

const functionMetrics = (path, text) => {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKind(path));
  const functions = [];
  const visitFunction = (node) => {
    const start = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    const end = source.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
    let complexity = 1;
    let maxDepth = 0;
    const walk = (child, depth) => {
      if (child !== node && ts.isFunctionLike(child)) return;
      let nextDepth = depth;
      if (
        ts.isIfStatement(child)
        || ts.isForStatement(child)
        || ts.isForInStatement(child)
        || ts.isForOfStatement(child)
        || ts.isWhileStatement(child)
        || ts.isDoStatement(child)
        || ts.isCatchClause(child)
        || ts.isConditionalExpression(child)
      ) {
        complexity += 1;
        nextDepth += 1;
      } else if (ts.isCaseClause(child)) {
        complexity += 1;
      } else if (ts.isBinaryExpression(child) && DECISION_LOGICAL.has(child.operatorToken.kind)) {
        complexity += 1;
      }
      maxDepth = Math.max(maxDepth, nextDepth);
      ts.forEachChild(child, (grandchild) => walk(grandchild, nextDepth));
    };
    ts.forEachChild(node, (child) => walk(child, 0));
    functions.push({
      name: functionName(node, source),
      startLine: start,
      endLine: end,
      lines: end - start + 1,
      complexity,
      maxBranchDepth: maxDepth,
    });
  };
  const walkAll = (node) => {
    if (ts.isFunctionLike(node) && node.body) visitFunction(node);
    ts.forEachChild(node, walkAll);
  };
  walkAll(source);
  return functions;
};

const normalizedDuplicateLines = (text) => text.split(/\r?\n/).map((raw, index) => {
  let line = raw.trim().replace(/\s+/g, " ");
  line = line.replace(/\/\/.*$/, "").trim();
  if (!line || line === "{" || line === "}" || line === ");" || line === ";") return null;
  if (/^(import|export \{?|from )\b/.test(line)) return null;
  if (line.length < 12) return null;
  return { line: index + 1, text: line };
}).filter(Boolean);

const files = [];
const duplicateCandidates = [];
const DUP_WINDOW = 7;
for (const path of trackedFiles) {
  if (isGeneratedLike(path)) continue;
  const ext = extname(path).toLowerCase();
  if (!CODE_EXTENSIONS.has(ext) && !DUP_EXTENSIONS.has(ext) && ext !== ".md" && ext !== ".json" && ext !== ".yml" && ext !== ".yaml") continue;
  let text;
  try { text = await readFile(join(repoRoot, path), "utf8"); }
  catch { continue; }
  const stats = lineStats(text);
  const entry = { path, category: classify(path), extension: ext, ...stats, bytes: Buffer.byteLength(text) };
  if (CODE_EXTENSIONS.has(ext)) {
    const functions = functionMetrics(path, text);
    entry.functionCount = functions.length;
    entry.maxFunctionLines = functions.reduce((max, item) => Math.max(max, item.lines), 0);
    entry.maxComplexity = functions.reduce((max, item) => Math.max(max, item.complexity), 0);
    entry.maxBranchDepth = functions.reduce((max, item) => Math.max(max, item.maxBranchDepth), 0);
    entry.longFunctions = functions.filter((item) => item.lines >= 80).sort((a, b) => b.lines - a.lines).slice(0, 10);
    entry.complexFunctions = functions.filter((item) => item.complexity >= 15).sort((a, b) => b.complexity - a.complexity).slice(0, 10);
  }
  files.push(entry);

  if (DUP_EXTENSIONS.has(ext)) {
    const normalized = normalizedDuplicateLines(text);
    if (normalized.length >= DUP_WINDOW) {
      for (let i = 0; i <= normalized.length - DUP_WINDOW; i += 1) {
        const block = normalized.slice(i, i + DUP_WINDOW);
        const joined = block.map((item) => item.text).join("\n");
        if (joined.length < 180) continue;
        duplicateCandidates.push({
          hash: createHash("sha1").update(joined).digest("hex"),
          path,
          lines: block.map((item) => item.line),
          startLine: block[0].line,
          endLine: block.at(-1).line,
          sample: joined.slice(0, 240),
        });
      }
    }
  }
}

const dupGroups = new Map();
for (const candidate of duplicateCandidates) {
  const list = dupGroups.get(candidate.hash) ?? [];
  list.push(candidate);
  dupGroups.set(candidate.hash, list);
}
const repeatedGroups = [...dupGroups.values()]
  .filter((group) => new Set(group.map((item) => item.path)).size >= 2)
  .sort((a, b) => b.length - a.length);
const duplicateLinesByFile = new Map();
for (const group of repeatedGroups) {
  for (const hit of group) {
    const set = duplicateLinesByFile.get(hit.path) ?? new Set();
    for (const line of hit.lines) set.add(line);
    duplicateLinesByFile.set(hit.path, set);
  }
}
const duplicateByCategory = new Map();
for (const file of files.filter((item) => DUP_EXTENSIONS.has(item.extension))) {
  const category = file.category;
  const current = duplicateByCategory.get(category) ?? { candidateLines: 0, duplicateCandidateLines: 0 };
  const text = await readFile(join(repoRoot, file.path), "utf8");
  const candidateLines = normalizedDuplicateLines(text).length;
  current.candidateLines += candidateLines;
  current.duplicateCandidateLines += duplicateLinesByFile.get(file.path)?.size ?? 0;
  duplicateByCategory.set(category, current);
}

const history = new Map();
const commitFiles = new Map();
const log = runGit(["log", "--no-merges", "--numstat", "--format=@@@%H%x09%s"]);
let currentCommit = null;
let currentSubject = "";
for (const raw of log.split(/\r?\n/)) {
  if (raw.startsWith("@@@")) {
    const payload = raw.slice(3);
    const tab = payload.indexOf("\t");
    currentCommit = tab >= 0 ? payload.slice(0, tab) : payload;
    currentSubject = tab >= 0 ? payload.slice(tab + 1) : "";
    if (!commitFiles.has(currentCommit)) commitFiles.set(currentCommit, new Set());
    continue;
  }
  if (!currentCommit || !raw.trim()) continue;
  const [addedRaw, deletedRaw, ...pathParts] = raw.split("\t");
  const path = pathParts.join("\t");
  if (!path || !trackedSet.has(path)) continue;
  const added = /^\d+$/.test(addedRaw) ? Number(addedRaw) : 0;
  const deleted = /^\d+$/.test(deletedRaw) ? Number(deletedRaw) : 0;
  const row = history.get(path) ?? { path, touches: 0, fixTouches: 0, added: 0, deleted: 0, churn: 0 };
  row.touches += 1;
  if (/^(?:(fix|hotfix|bugfix)(?:\(|:|\b)|修复|纠正|回归|regression|bug)/i.test(currentSubject)) row.fixTouches += 1;
  row.added += added;
  row.deleted += deleted;
  row.churn += added + deleted;
  history.set(path, row);
  commitFiles.get(currentCommit).add(path);
}

const eligibleForCochange = (path) => path.startsWith("apps/") || path.startsWith("packages/") || path.startsWith("scripts/") || path.startsWith("tests/");
const cochange = new Map();
for (const set of commitFiles.values()) {
  const paths = [...set].filter(eligibleForCochange).sort();
  if (paths.length < 2 || paths.length > 25) continue;
  for (let i = 0; i < paths.length; i += 1) {
    for (let j = i + 1; j < paths.length; j += 1) {
      const key = `${paths[i]}\u0000${paths[j]}`;
      cochange.set(key, (cochange.get(key) ?? 0) + 1);
    }
  }
}
const topCochange = [...cochange.entries()]
  .map(([key, count]) => { const [a, b] = key.split("\u0000"); return { a, b, count }; })
  .filter((item) => item.count >= 3)
  .sort((a, b) => b.count - a.count || a.a.localeCompare(b.a))
  .slice(0, 30);

const apiDomains = new Set(["access", "auth", "erp", "pattern-room", "platform", "receiving", "reporting", "rework", "samples", "sourcing", "todos", "tools", "wages"]);
const domainImports = new Map();
const relativeTarget = (sourcePath, specifier) => {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(repoRoot, dirname(sourcePath), specifier);
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.mjs`, join(base, "index.ts"), join(base, "index.tsx")];
  for (const candidate of candidates) {
    const rel = relative(repoRoot, candidate).replaceAll("\\", "/").replace(/\.js$/, ".ts");
    if (trackedSet.has(rel)) return rel;
    const relTsx = rel.replace(/\.ts$/, ".tsx");
    if (trackedSet.has(relTsx)) return relTsx;
  }
  return null;
};
const apiDomainOf = (path) => {
  const match = path.match(/^apps\/api\/src\/([^/]+)\//);
  return match && apiDomains.has(match[1]) ? match[1] : null;
};
for (const file of files.filter((item) => CODE_EXTENSIONS.has(item.extension) && item.path.startsWith("apps/api/src/"))) {
  const fromDomain = apiDomainOf(file.path);
  if (!fromDomain) continue;
  const text = await readFile(join(repoRoot, file.path), "utf8");
  const source = ts.createSourceFile(file.path, text, ts.ScriptTarget.Latest, true, scriptKind(file.path));
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const target = relativeTarget(file.path, statement.moduleSpecifier.text);
    const toDomain = target ? apiDomainOf(target) : null;
    if (!toDomain || toDomain === fromDomain) continue;
    const key = `${fromDomain}->${toDomain}`;
    domainImports.set(key, (domainImports.get(key) ?? 0) + 1);
  }
}

const metricsByCategory = new Map();
for (const file of files) {
  const row = metricsByCategory.get(file.category) ?? { files: 0, lines: 0, codeApprox: 0, bytes: 0, functions: 0 };
  row.files += 1;
  row.lines += file.lines;
  row.codeApprox += file.codeApprox;
  row.bytes += file.bytes;
  row.functions += file.functionCount ?? 0;
  metricsByCategory.set(file.category, row);
}

const runtimeCategories = new Set(["api-runtime", "web-runtime", "packages", "scripts"]);
const runtimeFiles = files.filter((file) => runtimeCategories.has(file.category) && CODE_EXTENSIONS.has(file.extension));
const topBy = (field, limit = 20) => [...runtimeFiles].sort((a, b) => (b[field] ?? 0) - (a[field] ?? 0)).slice(0, limit)
  .map((item) => ({ path: item.path, value: item[field] ?? 0, category: item.category }));
const historyRows = [...history.values()].filter((row) => runtimeCategories.has(classify(row.path)) || row.path.startsWith("tests/"));
const topTouches = [...historyRows].sort((a, b) => b.touches - a.touches || b.churn - a.churn).slice(0, 30);
const topFixTouches = [...historyRows].sort((a, b) => b.fixTouches - a.fixTouches || b.touches - a.touches).slice(0, 30);
const topChurn = [...historyRows].sort((a, b) => b.churn - a.churn || b.touches - a.touches).slice(0, 30);
const candidateDupGroups = repeatedGroups.slice(0, 30).map((group) => ({
  occurrences: group.length,
  distinctFiles: new Set(group.map((item) => item.path)).size,
  sample: group[0].sample,
  locations: group.slice(0, 12).map((item) => ({ path: item.path, startLine: item.startLine, endLine: item.endLine })),
}));

const duplicateSummary = Object.fromEntries([...duplicateByCategory.entries()].map(([category, row]) => [category, {
  ...row,
  candidateDuplicateRatio: row.candidateLines ? Number((row.duplicateCandidateLines / row.candidateLines).toFixed(4)) : 0,
}]));

const report = {
  generatedAt: new Date().toISOString(),
  repository: "lizhonghao31-crypto/dx-rework",
  sha,
  branch,
  methodology: {
    complexity: "AST-based cyclomatic candidate metric: base 1 + branches/loops/catch/ternary/case/logical short-circuit; informational only.",
    duplicate: `Exact normalized ${DUP_WINDOW}-logical-line windows repeated across >=2 distinct tracked files; imports, blank lines, trivial braces and short lines excluded. This is a candidate duplicate ratio, not a semantic-clone percentage.`,
    hotspots: "Non-merge git history; per-file touch count, fix-labelled touch count, and added+deleted churn. Co-change excludes commits touching >25 eligible files.",
  },
  totals: {
    trackedFiles: trackedFiles.length,
    measuredFiles: files.length,
    runtimeCodeFiles: runtimeFiles.length,
    runtimeApproxCodeLines: runtimeFiles.reduce((sum, file) => sum + file.codeApprox, 0),
    runtimeFunctions: runtimeFiles.reduce((sum, file) => sum + (file.functionCount ?? 0), 0),
    migrations: trackedFiles.filter((path) => path.startsWith("apps/api/migrations/") && path.endsWith(".sql")).length,
    tests: trackedFiles.filter((path) => path.startsWith("tests/") && CODE_EXTENSIONS.has(extname(path))).length,
  },
  byCategory: Object.fromEntries([...metricsByCategory.entries()].sort(([a], [b]) => a.localeCompare(b))),
  complexity: {
    largestFilesByApproxCodeLines: topBy("codeApprox"),
    largestFilesByBytes: topBy("bytes"),
    highestMaxFunctionComplexity: topBy("maxComplexity"),
    longestMaxFunction: topBy("maxFunctionLines"),
    deepestBranching: topBy("maxBranchDepth"),
    filesWithComplexFunctions: runtimeFiles.filter((file) => file.complexFunctions?.length).map((file) => ({ path: file.path, functions: file.complexFunctions })),
    filesWithLongFunctions: runtimeFiles.filter((file) => file.longFunctions?.length).map((file) => ({ path: file.path, functions: file.longFunctions })),
  },
  duplication: {
    byCategory: duplicateSummary,
    repeatedWindowGroups: repeatedGroups.length,
    topGroups: candidateDupGroups,
  },
  hotspots: {
    topTouches,
    topFixLabelTouches: topFixTouches,
    topChurn,
    topCochange,
  },
  architecture: {
    apiCrossDomainImports: [...domainImports.entries()].map(([edge, count]) => ({ edge, count })).sort((a, b) => b.count - a.count || a.edge.localeCompare(b.edge)),
  },
};

const mdTable = (headers, rows) => {
  const head = `| ${headers.join(" | ")} |\n| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows.map((row) => `| ${row.map((value) => String(value).replaceAll("|", "\\|").replaceAll("\n", " ")).join(" | ")} |`).join("\n");
  return body ? `${head}\n${body}` : `${head}\n| ${headers.map(() => "—").join(" | ")} |`;
};

const categoryRows = [...metricsByCategory.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, row]) => [name, row.files, row.codeApprox, row.functions]);
const complexityRows = report.complexity.highestMaxFunctionComplexity.slice(0, 15).map((row) => [row.path, row.value]);
const longRows = report.complexity.longestMaxFunction.slice(0, 15).map((row) => [row.path, row.value]);
const touchRows = topTouches.slice(0, 15).map((row) => [row.path, row.touches, row.fixTouches, row.churn]);
const dupRows = Object.entries(duplicateSummary).map(([category, row]) => [category, row.candidateLines, row.duplicateCandidateLines, `${(row.candidateDuplicateRatio * 100).toFixed(2)}%`]);
const edgeRows = report.architecture.apiCrossDomainImports.slice(0, 20).map((row) => [row.edge, row.count]);
const md = `# 达兴数字助手全仓代码治理审计（程序化基线）\n\n- Repository: \`${report.repository}\`\n- SHA: \`${sha}\`\n- Branch: \`${branch}\`\n- Generated: ${report.generatedAt}\n- 性质：**只读统计，不修改业务数据，不作为自动重构或发布判定。**\n\n## 1. 总量\n\n- Git tracked files: **${report.totals.trackedFiles}**\n- 本次统计文件: **${report.totals.measuredFiles}**\n- Runtime JS/TS files: **${report.totals.runtimeCodeFiles}**\n- Runtime approx code lines: **${report.totals.runtimeApproxCodeLines}**\n- Runtime functions: **${report.totals.runtimeFunctions}**\n- SQL migrations: **${report.totals.migrations}**\n- Test JS/TS files: **${report.totals.tests}**\n\n${mdTable(["category", "files", "approx code lines", "functions"], categoryRows)}\n\n## 2. 复杂度候选热点\n\n### 单文件最高函数复杂度\n${mdTable(["file", "max complexity"], complexityRows)}\n\n### 单文件最长函数\n${mdTable(["file", "max function lines"], longRows)}\n\n> 复杂度为 AST 候选指标，仅用于排序。高分不自动等于缺陷或必须重构。\n\n## 3. 候选重复率\n\n${mdTable(["category", "candidate lines", "duplicate candidate lines", "candidate ratio"], dupRows)}\n\n- Repeated normalized-window groups: **${report.duplication.repeatedWindowGroups}**\n- 口径：${report.methodology.duplicate}\n\n## 4. 修改热点\n\n${mdTable(["file", "touches", "fix-labelled touches", "churn"], touchRows)}\n\n> 修改热点基于非 merge 历史；新增功能频繁修改与反复修复必须在人工复核阶段区分。\n\n## 5. API 跨业务域依赖\n\n${mdTable(["edge", "relative import count"], edgeRows)}\n\n## 6. 下一步人工复核原则\n\n1. 优先查看同时满足“复杂度高 + 修改频繁 + 真实业务风险高”的交集，不按单一指标排施工顺序。\n2. 权限与金额/数量路径即使代码不大，也按业务风险进入专项审计。\n3. UI 重复样式先判断是否违反现行返工 UI Golden Source，再决定提取共享层；不为降低重复率强行统一不同业务布局。\n4. 历史 migration 不按普通 runtime 重复率判定技术债；历史不可为了指标美化而重写。\n5. 本报告只提供程序化事实与候选热点，治理 PR 必须另行绑定具体业务验收。\n`;

await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
await writeFile(join(outDir, "report.md"), md, "utf8");
console.log(`CODEBASE_GOVERNANCE_AUDIT_OK sha=${sha} out=${outDir}`);
