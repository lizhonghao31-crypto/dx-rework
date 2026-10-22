import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  containsSecretSignature,
  findArtifactSecrets,
  findHistoricalSecretFindings,
  findPotentialSecrets,
} from "../../scripts/secret-scan.mjs";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function createFixtureDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "dx-rework-secret-scan-"));
  temporaryDirectories.push(directory);
  return directory;
}

const initRepo = (): string => {
  const root = mkdtempSync(join(tmpdir(), "dx-secret-history-"));
  temporaryDirectories.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "fixture@example.invalid"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Fixture"], { cwd: root });
  return root;
};

const commitAll = (root: string, message: string): void => {
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["commit", "-qm", message], { cwd: root });
};

describe("secret scan", () => {
  it("scans secret-bearing extensions instead of relying on an allowlist", async () => {
    const directory = await createFixtureDirectory();
    await writeFile(join(directory, "credential.pem"), ["-----BEGIN ", "PRIVATE KEY-----"].join(""));
    await writeFile(join(directory, ".env"), ["TOKEN=gh", "p_", "a".repeat(30)].join(""));
    await writeFile(join(directory, "notes.txt"), ["AK", "IA", "A".repeat(16)].join(""));
    await mkdir(join(directory, "upload"));
    await writeFile(join(directory, "upload", "credential.key"), ["-----BEGIN ", "PRIVATE KEY-----"].join(""));

    await expect(findPotentialSecrets(directory, new Set())).resolves.toEqual([
      ".env",
      "credential.pem",
      "notes.txt",
      "upload/credential.key",
    ]);
  });

  it("skips binary files", async () => {
    const directory = await createFixtureDirectory();
    await writeFile(join(directory, "asset.bin"), Buffer.from([0, 1, 2, 3, 65, 75, 73, 65]));
    await expect(findPotentialSecrets(directory, new Set())).resolves.toEqual([]);
  });

  it("recognizes provider tokens and sensitive assignments without treating placeholders as secrets", () => {
    const providerToken = ["ghp_", "A".repeat(32)].join("");
    const assignedSecret = ["SESSION_SECRET=", "A1b2C3d4".repeat(4)].join("");
    expect(containsSecretSignature(providerToken)).toBe(true);
    expect(containsSecretSignature(assignedSecret)).toBe(true);
    expect(containsSecretSignature("SESSION_SECRET=replace_with_at_least_32_random_characters")).toBe(false);
    expect(containsSecretSignature("OPENAI_API_KEY=production-openai-key")).toBe(false);
    expect(containsSecretSignature("SESSION_SECRET=a-test-session-secret-with-at-least-32-characters")).toBe(false);
    expect(containsSecretSignature("DINGTALK_WEB_CLIENT_SECRET=web-client-secret-test")).toBe(false);
    expect(containsSecretSignature("SESSION_SECRET=0123456789abcdef0123456789abcdef")).toBe(false);
    expect(containsSecretSignature("SESSION_SECRET=12345678901234567890123456789012")).toBe(false);
    expect(containsSecretSignature("SESSION_SECRET=root-single-account-gate-secret-0000000000000000")).toBe(false);
    expect(containsSecretSignature("OSS_ACCESS_KEY_SECRET=\nOSS_PRIVATE_PREFIX=dx-rework/private")).toBe(false);
    expect(containsSecretSignature("OPENAI_API_KEY=\nOPENAI_VISION_MODEL=gpt-5.6")).toBe(false);
  });

  it("scans built first-party artifacts separately from ignored worktree build directories", async () => {
    const root = await createFixtureDirectory();
    const dist = join(root, "apps/web/dist/assets");
    await mkdir(dist, { recursive: true });
    await writeFile(join(dist, "app.js"), ["OPENAI_API_KEY=", "Q7w6E5r4".repeat(4)].join(""));
    await expect(findArtifactSecrets(root)).resolves.toEqual(["apps/web/dist/assets/app.js"]);
  });

  it("validates historical candidate lines with the same token boundaries while retaining removed real signatures", () => {
    const root=initRepo(),ordinary="tests/acceptance/task-session-navigation-browser.mjs";
    writeFileSync(join(root,"guide.md"),`Run ${ordinary}`);
    const tokens=[['sk-','A'.repeat(30)].join(''),['ghp_','B'.repeat(32)].join(''),['github_pat_','C'.repeat(24)].join(''),['AKIA','D'.repeat(16)].join(''),['LTAI','e'.repeat(15)].join(''),['-----BEGIN','PRIVATE KEY-----'].join(' ')];
    for(const [index,token] of tokens.entries())writeFileSync(join(root,`provider-${index}.txt`),token);
    commitAll(root,"synthetic historical detection fixture");
    for(const [index] of tokens.entries())writeFileSync(join(root,`provider-${index}.txt`),'removed');
    writeFileSync(join(root,"guide.md"),`Keep ${ordinary} as the original regression`);
    commitAll(root,"remove credentials and update ordinary filename reference");
    expect(containsSecretSignature(ordinary)).toBe(false);
    const findings=findHistoricalSecretFindings(root);
    expect(findings.signatures.some(item=>item.endsWith(':guide.md'))).toBe(false);
    for(const [index,token] of tokens.entries()){
      expect(findings.signatures.filter(item=>item.endsWith(`:provider-${index}.txt`))).toHaveLength(2);
      expect(JSON.stringify(findings)).not.toContain(token);
    }
  });

  it("detects removed line-leading signatures introduced only by a merge resolution",()=>{
    const root=initRepo(),git=(...args:string[])=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
    writeFileSync(join(root,'base.txt'),'base');commitAll(root,'base');const branch=git('branch','--show-current');
    git('checkout','-qb','side');writeFileSync(join(root,'side.txt'),'side');commitAll(root,'side');const side=git('rev-parse','HEAD');
    git('checkout','-q',branch);writeFileSync(join(root,'main.txt'),'main');commitAll(root,'main');const main=git('rev-parse','HEAD');
    const marker=['-----BEGIN','PRIVATE KEY-----'].join(' ');
    writeFileSync(join(root,'notes.txt'),marker);git('add','notes.txt');const tree=git('write-tree'),merge=git('commit-tree',tree,'-p',main,'-p',side,'-m','synthetic merge-resolution marker');
    git('update-ref',`refs/heads/${branch}`,merge);git('reset','--hard',merge);
    rmSync(join(root,'notes.txt'));commitAll(root,'remove synthetic marker');const removed=git('rev-parse','HEAD').slice(0,12);
    const findings=findHistoricalSecretFindings(root);expect(findings.signatures).toContain(`${removed}:notes.txt`);expect(JSON.stringify(findings)).not.toContain(marker);
  });

  it("finds removed signatures, sensitive assignments and tracked secret files without returning secret values", () => {
    const root = initRepo();
    const historicalToken = ["sk-", "A".repeat(30)].join("");
    const historicalAssignedSecret = ["A1b2C3d4"].join("").repeat(4);
    writeFileSync(join(root, "leak.txt"), historicalToken);
    writeFileSync(join(root, "ordinary.txt"), `SESSION_SECRET=${historicalAssignedSecret}`);
    writeFileSync(join(root, "synthetic.txt"), "SESSION_SECRET=history-test-secret-with-at-least-32-characters");
    writeFileSync(join(root, ".env"), "SESSION_SECRET=historical-placeholder");
    commitAll(root, "introduce fixture leak");

    writeFileSync(join(root, "leak.txt"), "clean");
    writeFileSync(join(root, "ordinary.txt"), "clean");
    writeFileSync(join(root, "synthetic.txt"), "clean");
    rmSync(join(root, ".env"));
    commitAll(root, "remove fixture leak");

    const findings = findHistoricalSecretFindings(root);
    expect(findings.signatures.some((item) => item.endsWith(":leak.txt"))).toBe(true);
    expect(findings.signatures.some((item) => item.endsWith(":ordinary.txt"))).toBe(true);
    expect(findings.signatures.some((item) => item.endsWith(":synthetic.txt"))).toBe(false);
    expect(findings.sensitivePaths.some((item) => item.endsWith(":.env"))).toBe(true);
    expect(JSON.stringify(findings)).not.toContain(historicalToken);
    expect(JSON.stringify(findings)).not.toContain(historicalAssignedSecret);
  });
});
