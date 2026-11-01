import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync,existsSync} from 'node:fs';
import {testExecutionConfig} from '../test-execution-config.mjs';
const active=['AGENTS.md','docs/governance/chatgpt-codex-construction-workflow-v1.0.md','docs/governance/github-actions-usage-policy-v1.0.md','docs/governance/review-first-final-head-20261027.md','docs/governance/construction-evidence-v1.md'];
test('active rules have real references and no old task pauses, minute reporting or Gate-before-Review',()=>{
 for(const p of active){const s=readFileSync(p,'utf8');for(const forbidden of ['不推进 #882','不恢复 PR04','每分钟必须','每 1 分钟','main 是唯一事实来源','Gate 全绿后再 Review'])assert.ok(!s.includes(forbidden),p+': '+forbidden);
 for(const[,ref]of s.matchAll(/`((?:scripts|docs)\/[a-zA-Z0-9_./-]+\.(?:mjs|md|json))`/g))assert.ok(existsSync(ref),p+' missing '+ref);
 }
});
test('worker values have one runtime source and both configurations consume it',()=>{
 assert.deepEqual(testExecutionConfig.workers,{nonDatabase:1,postgres:1,longCorrectness:2});
 for(const p of ['vitest.config.ts','vitest.business-chain.config.ts']){const s=readFileSync(p,'utf8');assert.ok(s.includes('test-execution-config.mjs'));assert.ok(s.includes('testExecutionConfig.workers'));assert.ok(!/maxWorkers:\s*\d/.test(s));}
 for(const p of ['.github/workflows/ci.yml','.github/workflows/full-gate.yml']){const s=readFileSync(p,'utf8');assert.ok(s.includes('node-version-file: .node-version'));assert.ok(!/--maxWorkers|--max-workers|VITEST_MAX_THREADS/.test(s));assert.ok(s.includes('construction-evidence.mjs verify-change'));}
});
