import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,writeFileSync,mkdirSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
const workflow=readFileSync('.github/workflows/full-gate.yml','utf8');
const step=workflow.split('      - name: PostgreSQL backup and isolated restore drill\n')[1].split('\n      - name:')[0];
const block=step.split('        run: |\n')[1].split('\n').map(line=>line.startsWith('          ')?line.slice(10):line).join('\n');
const check=block.slice(0,block.indexOf('node_bin='));
for(const [client,server,success]of [[16,16,true],[18,16,false],[16,15,false]])test(`backup drill checks pinned client${client}/server${server} before archive creation`,()=>{
 const root=mkdtempSync(join(tmpdir(),'dx-pg-drill-toolchain-'));
 try{
  const bin=join(root,'bin');mkdirSync(bin);
  for(const tool of ['psql','pg_dump','pg_restore'])writeFileSync(join(bin,tool),`#!/bin/sh\nif [ "$1" = --version ]; then printf '%s\\n' '${tool} (PostgreSQL) ${client}.1'; else printf '%s\\n' '${server*10000}'; fi\n`,{mode:0o700});
  // Adapt only the unavailable machine-specific path; execute the original
  // workflow precheck and the original deployment-library tool validator.
  const result=spawnSync('bash',['-c',check.replace('/usr/lib/postgresql/16/bin',bin)],{encoding:'utf8',env:{...process.env,RUNNER_TEMP:root,DATABASE_URL:'postgresql://TEST@127.0.0.1/TEST'}});
  assert.equal(result.status===0,success,result.stderr+result.stdout);
  if(!success)assert.match(result.stdout,/requires PostgreSQL 16/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('backup and restore use the same pinned toolchain and retain all original restore guards',()=>{
 assert.match(workflow,/runs-on: ubuntu-24\.04/);
 assert.match(block,/printf 'DX_REWORK_PG_BIN_DIR=%s\\n'/);
 assert.ok(block.indexOf('assert_postgres_toolchain')<block.indexOf('scripts/backup-postgres.sh'));
 assert.match(block,/scripts\/backup-postgres\.sh/);assert.match(block,/scripts\/restore-postgres\.sh/);
 assert.match(block,/DX_REWORK_APPROVED_TARGET_FINGERPRINT/);assert.match(block,/verify-database-readiness\.mjs/);
 assert.doesNotMatch(block,/transaction_timeout|sed .*dump|exit-on-error=false/);
});
