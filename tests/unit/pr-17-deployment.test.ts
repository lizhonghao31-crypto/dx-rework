import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
const root=process.cwd();
const run=(code:string,env:Record<string,string>={})=>spawnSync("bash",["-c",`source scripts/deploy/lib.sh; ${code}`],{cwd:root,encoding:"utf8",env:{...process.env,...env}});
describe("PR-17 deployment fail-closed contract",()=>{
 it("accepts only a full lowercase SHA",()=>{expect(run("require_sha 0123456789abcdef0123456789abcdef01234567").status).toBe(0); for(const x of ["","abc","A123456789abcdef0123456789abcdef01234567","0123456789abcdef0123456789abcdef0123456*"])expect(run(`require_sha '${x}'`).status).not.toBe(0)});
 it("rejects empty, control, glob and traversal values",()=>{for(const x of ["","../x","a*b","a?b","a[bc]"])expect(run(`reject_unsafe_value '${x}'`).status).not.toBe(0);expect(run("reject_unsafe_value $'a\\nb'").status).not.toBe(0)});
 it("rejects relative, escaped, ERP/sample and symlink paths",()=>{const t=mkdtempSync(join(tmpdir(),"pr17-path-"));mkdirSync(join(t,"ok"));symlinkSync("/tmp",join(t,"ok","link"));for(const p of ["relative","/opt/daxing-erp/x","/opt/daxing-sample/x",`${t}/../escape`,`${t}/ok/link/x`])expect(run(`assert_safe_path '${p}' '${t}'`)).toMatchObject({status:expect.not.stringMatching(/^0$/)})});
 it("redacts credentials and sensitive query/header data",()=>{const r=run("safe_log fail 'postgresql://user:pass@host/db?token=abc&signature=xyz Authorization=Bearer123 session=q'");expect(r.stdout).not.toMatch(/pass@|abc|xyz|Bearer123|session=q/);expect(r.stdout).toContain("REDACTED")});
 it("all shell scripts parse",()=>{const files=execFileSync("bash",["-c","find scripts -type f -name '*.sh' -print0"],{cwd:root}).toString().split("\0").filter(Boolean);for(const f of files)expect(spawnSync("bash",["-n",f],{cwd:root}).status,f).toBe(0)});
 it("forbids broad process, nginx, host-key and foreign writes",()=>{const files=execFileSync("bash",["-c","find scripts/deploy -type f -name '*.sh' -print"],{cwd:root,encoding:"utf8"}).trim().split("\n");const body=files.map(f=>readFileSync(join(root,f),"utf8")).join("\n");expect(body).not.toMatch(/pm2\s+(kill|delete all|restart all)|StrictHostKeyChecking=no|rm\s+-rf\s+\/opt\/daxing/);expect(body).not.toContain("eval ")});
});
