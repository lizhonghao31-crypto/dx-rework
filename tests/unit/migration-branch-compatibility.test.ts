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
 it('only permits exact approved identity/checksum prefix pairs',()=>{
  expect(()=>assertMigrationSequence(target)).not.toThrow();
  const fake={version:'0218_unapproved',checksum:'0'.repeat(64)};
  expect(()=>assertMigrationSequence(sorted([...target,fake]))).toThrow();
  expect(()=>assertMigrationSequence(target.map(r=>r.version===branches.main[0]!.version?{...r,checksum:'0'.repeat(64)}:r))).toThrow('Frozen');
  expect(()=>assertMigrationSequence(target.filter(r=>!r.version.startsWith('0227_')))).toThrow('sequence gap');
 });
 it('admits precisely the main hotfix and existing digital 0231 without accepting a third identity or drift',()=>{
  const version='0231_temporary_special_process_proxy_reporting',checksum='39a9c918c6589c9905ab0cf32de1f7cc304119fd4840a3fa8da34ddfb3e3d6b4';
  expect(target.filter(row=>row.version.startsWith('0231_'))).toEqual([{version:'0231_digital_order_closure',checksum:target.find(row=>row.version==='0231_digital_order_closure')!.checksum},{version,checksum}]);
  expect(()=>assertAppliedMigrationHistory(target.filter(row=>![version,'0232_pmc_readonly_role'].includes(row.version)),target)).not.toThrow();
  expect(()=>assertMigrationSequence(sorted([...target,{version:'0231_unapproved_third',checksum:'0'.repeat(64)}]))).toThrow();
  expect(()=>assertMigrationSequence(target.map(row=>row.version===version?{...row,checksum:'0'.repeat(64)}:row))).toThrow('Frozen');
  expect(()=>assertAppliedMigrationHistory(target.filter(row=>row.version!=='0230_sourcing_factory_change_current_quantity'),target)).toThrow();
 });
 it('keeps exact PMC main history and pre-PMC release history valid, without admitting another 0232 fork',()=>{
  const extensions:Entry[]=JSON.parse(readFileSync('scripts/migration-main-extensions.json','utf8'));
  const main=sorted([...common,...branches.main,...extensions]);
  const oldRelease=target.filter(row=>row.version!=='0232_pmc_readonly_role');
  for(const history of [main,oldRelease]){const before=JSON.stringify(history);expect(()=>assertAppliedMigrationHistory(history,target)).not.toThrow();expect(JSON.stringify(history)).toBe(before);}
  expect(()=>assertMigrationSequence(sorted([...target,{version:'0232_unapproved_third',checksum:'0'.repeat(64)}]))).toThrow();
  for(const version of ['0232_pmc_readonly_role','0232_reconcile_contract_and_digital_histories'])expect(()=>assertMigrationSequence(target.map(row=>row.version===version?{...row,checksum:'0'.repeat(64)}:row))).toThrow('Frozen');
  expect(()=>assertAppliedMigrationHistory(main.filter(row=>row.version!=='0231_temporary_special_process_proxy_reporting'),target)).toThrow();
 });
});
