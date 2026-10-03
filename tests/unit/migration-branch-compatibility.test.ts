import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {assertAppliedMigrationHistory,assertMigrationSequence} from '../../scripts/migration-history-policy.mjs';

type Entry={version:string;checksum:string};
const target:Entry[]=JSON.parse(readFileSync('apps/api/src/platform/migration-manifest.json','utf8')).migrations;
const branches:{main:Entry[];digital:Entry[]}=JSON.parse(readFileSync('scripts/migration-branches.json','utf8'));
const common=target.slice(0,217);
const sorted=(rows:Entry[])=>[...rows].sort((a,b)=>a.version.localeCompare(b.version));
describe('frozen main / digital migration reconciliation',()=>{
 it('accepts both historical lanes and every resumable prefix without mutating them',()=>{
  for(let m=0;m<=branches.main.length;m++)for(let d=0;d<=branches.digital.length;d++){
   const rows=sorted([...common,...branches.main.slice(0,m),...branches.digital.slice(0,d)]),before=JSON.stringify(rows);
   expect(()=>assertAppliedMigrationHistory(rows,target)).not.toThrow();expect(JSON.stringify(rows)).toBe(before);
  }
  expect(()=>assertAppliedMigrationHistory(target,target)).not.toThrow();
 });
 it('rejects holes in either original lane and missing shared migrations',()=>{
  for(const lane of Object.values(branches))for(let i=0;i<lane.length-1;i++){
   expect(()=>assertAppliedMigrationHistory(sorted([...common,...lane.filter((_,n)=>n!==i)]),target)).toThrow();
  }
  expect(()=>assertAppliedMigrationHistory([...common.slice(0,-1),...branches.main],target)).toThrow();
 });
 it('rejects checksum drift, unknown history, duplicates and premature unified markers',()=>{
  const original=sorted([...common,...branches.main]);
  expect(()=>assertAppliedMigrationHistory([...original.slice(0,-1),{...original.at(-1)!,checksum:'0'.repeat(64)}],target)).toThrow('checksum drift');
  expect(()=>assertAppliedMigrationHistory([...original,{version:'9999_unknown',checksum:'0'.repeat(64)}],target)).toThrow('absent from Head');
  expect(()=>assertAppliedMigrationHistory([...original,original.at(-1)!],target)).toThrow('Duplicate');
  expect(()=>assertAppliedMigrationHistory([...original,target.at(-1)!],target)).toThrow('both complete');
 });
 it('only permits the three exact frozen prefix collisions',()=>{
  expect(()=>assertMigrationSequence(target)).not.toThrow();
  const fake={version:'0218_unapproved',checksum:'0'.repeat(64)};
  expect(()=>assertMigrationSequence(sorted([...target,fake]))).toThrow();
  expect(()=>assertMigrationSequence(target.map(r=>r.version===branches.main[0]!.version?{...r,checksum:'0'.repeat(64)}:r))).toThrow('Frozen');
  expect(()=>assertMigrationSequence(target.filter(r=>!r.version.startsWith('0227_')))).toThrow('sequence gap');
 });
});
