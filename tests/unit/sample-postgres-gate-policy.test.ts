import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {describe,expect,it} from 'vitest';

describe('sample PostgreSQL gate coverage',()=>{
 const workflow=readFileSync(new URL('../../.github/workflows/full-gate.yml',import.meta.url),'utf8');
 const pattern=workflow.match(/case "\$path" in\n\s+([^\n]+)\)\n\s+business_chain_sensitive=true/)?.[1];
 it.each(['apps/api/src/samples/sample-analysis-service.ts','packages/contracts/src/sample-analysis.ts','tests/integration/sample-analysis-postgres.cases.ts','tests/integration/sample-read-postgres.test.ts'])('runs real PostgreSQL for %s',path=>{
  expect(pattern).toBeTruthy();
  expect(execFileSync('bash',['-c',`case "$1" in ${pattern}) printf yes;; *) printf no;; esac`,'gate-test',path],{encoding:'utf8'})).toBe('yes');
 });
 it.each(['apps/web/src/sample-operations.css','docs/roadmap/ui-polish-20260908-v1.0.md'])('does not escalate presentation-only %s',path=>{
  expect(execFileSync('bash',['-c',`case "$1" in ${pattern}) printf yes;; *) printf no;; esac`,'gate-test',path],{encoding:'utf8'})).toBe('no');
 });
});
