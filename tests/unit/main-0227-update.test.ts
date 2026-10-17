import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const target = "d".repeat(40), old = "c".repeat(40), tree = "a".repeat(40);
type Scenario = { pending?: string[]; phase?: string; active?: string; port?: number; remote?: string; remoteTree?: string; candidate?: string; toolDrift?: boolean; staleLauncher?: boolean; frozenTree?: string };

/** Executes the delivered Bash wrapper offline. Git, installation and runtime
 * probes are stubs; the separate PG13 fixture runs the real SQL/controller. */
function exercise(s: Scenario = {}, approval = "--approved-tree", approved = tree) {
  const root = mkdtempSync(join(tmpdir(), "main-0227-wrapper-"));
  const state = join(root, "state"), runtime = join(root, "runtime"), tools = join(root, "tools"), bin = join(root, "bin");
  const entries = join(root, "entries"), sources: string[] = [];
  const write = (path: string, content: string) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, content); };
  const executable = (name: string, code: string) => { write(join(bin, name), `#!${process.execPath}\n${code}`); spawnSync("chmod", ["0755", join(bin, name)]); };
  const scenario = { pending: ["0227_qc_other_craft"], phase: "completed", active: old, port: 3203, remote: target, remoteTree: tree, candidate: target, ...s };
  const config = join(root, "scenario.json"), calls = join(root, "calls.log"), clone = join(root, "clones.log");
  const preamble = `import * as fs from 'node:fs';import {spawnSync} from 'node:child_process';import {join} from 'node:path';const s=JSON.parse(fs.readFileSync(${JSON.stringify(config)}));const root=${JSON.stringify(root)},state=${JSON.stringify(state)},runtime=${JSON.stringify(runtime)},tools=${JSON.stringify(tools)},entries=${JSON.stringify(entries)};const log=x=>fs.appendFileSync(${JSON.stringify(calls)},x+'\\n');`;
  try {
    mkdirSync(state, { mode: 0o700 }); mkdirSync(entries); mkdirSync(bin); mkdirSync(join(root, "var"));
    write(config, JSON.stringify(scenario)); write(calls, ""); write(clone, "");
    write(join(state, "node-binary"), join(bin, "node22"));
    write(join(state, "nginx-config"), join(root, "etc/nginx/main.conf")); write(join(root, "etc/nginx/main.conf"), "fixture");
    write(join(state, "phase"), scenario.phase); write(join(state, "candidate-sha"), scenario.candidate);
    write(join(state, "active.json"), JSON.stringify({ sha: scenario.active, port: scenario.port }));
    write(join(runtime, "releases", old, "node_modules/.fixture"), "");
    write(join(runtime, "releases", target, "node_modules/.fixture"), "");
    spawnSync("ln", ["-s", join(runtime, "releases", scenario.active), join(runtime, "current")]);
    executable("id", "console.log('0');");
    executable("stat", `import {statSync} from 'node:fs';console.log(process.argv[3]==='%U'?'root':(statSync(process.argv.at(-1)).mode&511).toString(8));`);
    executable("chown", preamble + "log('chown '+process.argv.slice(2).join(' '));");
    executable("nginx", preamble + "log('nginx '+process.argv.slice(2).join(' '));");
    executable("npm", "console.log('10.9.9');"); executable("pm2", "process.exit(0);");
    write(join(bin, "node22"), `#!/bin/sh\nexec '${process.execPath}' "$@"\n`); spawnSync("chmod", ["0755", join(bin, "node22")]);
    executable("runuser", preamble + `const a=process.argv.slice(2),i=a.indexOf('--');const r=spawnSync(a[i+1],a.slice(i+2),{env:process.env,stdio:'inherit'});process.exit(r.status??1);`);
    const skeleton = join(root, "skeleton");
    write(join(skeleton, "apps/api/src/platform/migration-manifest.json"), '{"migrations":[{"version":"0227_qc_other_craft"}]}');
    cpSync("scripts/deploy/main-maintenance-plans.json", join(root, "plans.json"));
    write(join(skeleton, "scripts/deploy/main-maintenance-plans.json"), readFileSync("scripts/deploy/main-maintenance-plans.json", "utf8"));
    write(join(skeleton, "scripts/deploy/lib.sh"), `
assert_root_node(){ printf 'root-source\\n' >> '${calls}'; }
load_app_config(){ export DATABASE_URL=fixture; }
load_database_tool_config(){ export DX_REWORK_NODE_BIN='${bin}/node22'; }
approved_node_bin(){ printf '%s' "$DX_REWORK_NODE_BIN"; }
assert_postgres_toolchain(){ :; }
node_exec(){ if [[ "$1" == */check-main-maintenance-plan.mjs ]]; then '${process.execPath}' -e 'const s=require(process.argv[1]);console.log(JSON.stringify({pending:s.pending,onlineAllowed:s.pending.length===0}))' '${config}'; else '${bin}/node22' "$@"; fi; }
`);
    const install = join(root, "install.mjs"), native = join(root, "native.mjs");
    write(install, preamble + `log('install-main '+process.argv.slice(2).join(' '));const target=${JSON.stringify(target)};fs.mkdirSync(join(tools,target,'scripts/deploy'),{recursive:true});fs.copyFileSync(join(root,'plans.json'),join(tools,target,'scripts/deploy/main-maintenance-plans.json'));if(s.toolDrift)fs.appendFileSync(join(tools,target,'scripts/deploy/main-maintenance-plans.json'),'drift');for(const [entry,script,mode] of [['dx-rework-maintenance-update','update-main-maintenance.sh','maintenance'],['dx-rework-deploy','update-main-online.sh','online']]){fs.writeFileSync(join(tools,target,'scripts/deploy',script),'#!/bin/sh\\nexec '+${JSON.stringify(process.execPath)}+' '+${JSON.stringify(native)}+' '+mode+'\\n',{mode:0o755});fs.writeFileSync(join(entries,entry),'#!/bin/sh\\nexec bash '+join(tools,s.staleLauncher?'cccccccccccccccccccccccccccccccccccccccc':target,'scripts/deploy',script)+'\\n',{mode:0o755});}`);
    write(native, preamble + `log('entry-'+process.argv[2]+' expected='+process.env.DX_REWORK_EXPECTED_MAIN_SHA);if(process.env.DX_REWORK_EXPECTED_MAIN_SHA!==${JSON.stringify(target)})process.exit(1);const active=JSON.parse(fs.readFileSync(join(state,'active.json')));fs.writeFileSync(join(state,'active.json'),JSON.stringify({sha:${JSON.stringify(target)},port:active.port}));fs.writeFileSync(join(state,'phase'),'completed');fs.unlinkSync(join(runtime,'current'));fs.symlinkSync(join(runtime,'releases',${JSON.stringify(target)}),join(runtime,'current'));`);
    write(join(skeleton, "scripts/deploy/install-online-entry.sh"), `#!/bin/sh\nexec '${process.execPath}' '${install}' "$@"\n`);
    executable("git", preamble + `const a=process.argv.slice(2),dir=a[1],cmd=a[2];log('git '+cmd);if(cmd==='init')fs.appendFileSync(${JSON.stringify(clone)},dir+'\\n');if(cmd==='rev-parse'){const selected=a[3].startsWith('HEAD')?fs.readFileSync(join(dir,'.fixture-head'),'utf8'):a[3].split('^')[0];console.log(a[3].includes('tree')?(selected===s.remote?s.remoteTree:s.frozenTree??'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'):(a[3]==='HEAD'?selected:s.remote));}if(cmd==='checkout'){fs.writeFileSync(join(dir,'.fixture-head'),a.at(-1));fs.cpSync(${JSON.stringify(skeleton)},dir,{recursive:true});}`);
    executable("curl", preamble + `log('public-version');const a=JSON.parse(fs.readFileSync(join(state,'active.json')));console.log(JSON.stringify({gitSha:a.sha,schemaVersion:'0227_qc_other_craft',expectedSchemaVersion:'0227_qc_other_craft'}));`);
    const pythonPrelude = `import io,json,urllib.request\nclass Response(io.BytesIO):\n status=200\n headers={'X-Dx-Release-Protocol':'2'}\n def __enter__(self): return self\n def __exit__(self,*a): self.close()\nclass Opener:\n def open(self,url,timeout=5):\n  with open(${JSON.stringify(calls)},'a') as f: f.write('local-probe '+url+'\\n')\n  with open(${JSON.stringify(join(state, "active.json"))}) as f: a=json.load(f)\n  return Response(json.dumps({'gitSha':a['sha'],'schemaVersion':'0227_qc_other_craft','expectedSchemaVersion':'0227_qc_other_craft'}).encode())\nurllib.request.build_opener=lambda *a: Opener()\n`;
    executable("python3", preamble + `const a=process.argv.slice(2);if(a[0]==='-c'){const p=spawnSync('/usr/bin/python3',a,{env:process.env,stdio:'inherit'});process.exit(p.status??1);}if(a[0]!=='-'){log('static-'+a[1]);process.exit(0);}const code=fs.readFileSync(0,'utf8');const p=spawnSync('/usr/bin/python3',['-c',${JSON.stringify(pythonPrelude)}+'\\n'+code,...a.slice(1)],{env:process.env,stdio:'inherit'});process.exit(p.status??1);`);
    const script = join(root, "update.sh");
    write(script, readFileSync("docs/operations/main-0227-update.sh", "utf8")
      .replaceAll("/opt/dx-rework-release-state", state).replaceAll("/opt/dx-rework-release-tools", tools)
      .replaceAll("/opt/dx-rework", runtime).replaceAll("/etc/nginx/", join(root, "etc/nginx") + "/")
      .replaceAll("/usr/local/bin/dx-rework-", entries + "/dx-rework-").replaceAll("/var/tmp/", join(root, "var") + "/"));
    const result = spawnSync("bash", [script, approval, approved], { env: { PATH: bin + ":" + process.env.PATH }, encoding: "utf8", timeout: 20_000 });
    sources.push(...readFileSync(clone, "utf8").trim().split("\n").filter(Boolean));
    return { ...result, calls: readFileSync(calls, "utf8"), state: JSON.parse(readFileSync(join(state, "active.json"), "utf8")) };
  } finally { for (const path of sources) rmSync(path, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); }
}

describe("0227 production main delivery wrapper", () => {
  it("refreshes main tools first and selects the absolute maintenance entry for pending0227", () => {
    const r = exercise(); expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(r.calls.indexOf("chown -R root:root")).toBeLessThan(r.calls.indexOf("root-source"));
    expect(r.calls.indexOf("install-main")).toBeLessThan(r.calls.indexOf("entry-maintenance"));
    expect(r.calls).toContain(`entry-maintenance expected=${target}`); expect(r.calls).not.toContain("entry-online");
    expect(r.state).toEqual({ sha: target, port: 3203 }); expect(r.stdout).toContain("MAIN_0227_UPDATE_FINISHED");
  }, 25_000);
  it.each([3201, 3203])("returns success for an already-target release on port%s without invoking a release entry", port => {
    const r = exercise({ pending: [], active: target, port }); expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(r.stdout).toContain("ALREADY_CURRENT"); expect(r.calls).not.toContain("entry-"); expect(r.calls).toContain(`local-probe http://127.0.0.1:${port}/version`);
  }, 25_000);
  it("uses the normal absolute entry for a different SHA with an already-current full schema", () => {
    const r = exercise({ pending: [] }); expect(r.status, r.stderr + r.stdout).toBe(0); expect(r.calls).toContain("entry-online"); expect(r.calls).not.toContain("entry-maintenance");
  }, 25_000);
  it("resumes the same frozen candidate via maintenance even after its DDL committed", () => {
    const r = exercise({ pending: [], phase: "maintenance-migrated" }); expect(r.status, r.stderr + r.stdout).toBe(0); expect(r.calls).toContain(`entry-maintenance expected=${target}`);
  }, 25_000);
  it("resumes the approved frozen candidate even if main has advanced", () => {
    const r = exercise({ pending: [], phase: "maintenance-migrated", remote: "e".repeat(40), remoteTree: "f".repeat(40), frozenTree: tree });
    expect(r.status, r.stderr + r.stdout).toBe(0); expect(r.calls).toContain(`entry-maintenance expected=${target}`);
  }, 25_000);
  it("rejects an unmerged/unapproved tree before Root source or tool execution", () => {
    const r = exercise({ remoteTree: "e".repeat(40) }); expect(r.status).not.toBe(0); expect(r.stdout + r.stderr).toContain("MAIN_TREE_NOT_APPROVED"); expect(r.calls).not.toContain("root-source"); expect(r.calls).not.toContain("install-main");
  });
  it("rejects an unexpected exact main SHA before installation", () => {
    const r = exercise({}, "--approved-sha", old); expect(r.status).not.toBe(0); expect(r.calls).not.toContain("install-main");
  });
  it("rejects a different frozen maintenance target", () => {
    const r = exercise({ phase: "maintenance-migrating", candidate: old }, "--approved-sha", target); expect(r.status).not.toBe(0); expect(r.calls).not.toContain("install-main");
  });
  it("rejects an unsupported multi-migration preflight before installing tools", () => {
    const r = exercise({ pending: ["0226_external_revision_preserve_handler", "0227_qc_other_craft"] }); expect(r.status).not.toBe(0); expect(r.calls).not.toContain("install-main");
  });
  it("does not call a release entry if installed tools differ from the audited plan", () => {
    const r = exercise({ toolDrift: true }); expect(r.status).not.toBe(0); expect(r.calls).not.toContain("entry-");
  });
  it("rejects a stale installed launcher even when the new plan was copied", () => {
    const r = exercise({ staleLauncher: true }); expect(r.status).not.toBe(0); expect(r.calls).toContain("install-main"); expect(r.calls).not.toContain("entry-");
  });

});
