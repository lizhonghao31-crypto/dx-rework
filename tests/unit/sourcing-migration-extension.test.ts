import {readFileSync} from 'node:fs';
import {describe,it,expect} from 'vitest';
import {assertAppliedMigrationHistory,assertMigrationSequence} from '../../scripts/migration-history-policy.mjs';
type Entry={version:string;checksum:string};
const load=(path:string):Entry[]=>JSON.parse(readFileSync(path,'utf8')).migrations;
const main=load('tests/fixtures/migration-histories/main-9fcc05c4.json');
const release=load('tests/fixtures/migration-histories/release-e9d687a3.json');
const integrated=load('apps/api/src/platform/migration-manifest.json');
const extension:Entry[]=JSON.parse(readFileSync('scripts/migration-main-extensions.json','utf8'));
const branches:{main:Entry[];digital:Entry[]}=JSON.parse(readFileSync('scripts/migration-branches.json','utf8'));
const sorted=(rows:Entry[])=>[...rows].sort((a,b)=>a.version.localeCompare(b.version));
describe('reuse exact main extension beside the released digital 0221 identity',()=>{
 it('accepts actual main221, Acceptance236 and integrated237 histories',()=>{
  expect([main.length,release.length,integrated.length]).toEqual([221,236,237]);
  for(const history of [main,release,integrated])expect(()=>assertAppliedMigrationHistory(history,integrated)).not.toThrow();
  expect(()=>assertMigrationSequence(integrated)).not.toThrow();
  expect(integrated.filter(r=>r.version.startsWith('0221_'))).toHaveLength(2);
 });
 it('keeps resumable prefixes without admitting lane holes or a third 0221',()=>{
  const common=main.slice(0,217),lane=[...branches.main,...extension];
  for(let m=0;m<=lane.length;m++)for(let d=0;d<=branches.digital.length;d++){
   const applied=sorted([...common,...lane.slice(0,m),...branches.digital.slice(0,d)]),before=JSON.stringify(applied);
   expect(()=>assertAppliedMigrationHistory(applied,integrated)).not.toThrow();expect(JSON.stringify(applied)).toBe(before);
  }
  expect(()=>assertAppliedMigrationHistory(sorted([...common,...extension]),integrated)).toThrow();
  expect(()=>assertMigrationSequence(sorted([...integrated,{version:'0221_unapproved',checksum:'0'.repeat(64)}]))).toThrow();
 });
 it('rejects checksum drift, unknown history and duplicate applied identities',()=>{
  expect(()=>assertAppliedMigrationHistory(main.map(r=>r.version===extension[0]!.version?{...r,checksum:'0'.repeat(64)}:r),integrated)).toThrow('checksum drift');
  expect(()=>assertMigrationSequence(integrated.map(r=>r.version===extension[0]!.version?{...r,checksum:'0'.repeat(64)}:r))).toThrow('checksum drift');
  expect(()=>assertAppliedMigrationHistory([...integrated,extension[0]!],integrated)).toThrow('Duplicate');
  expect(()=>assertAppliedMigrationHistory([...integrated,{version:'9999_unapproved',checksum:'0'.repeat(64)}],integrated)).toThrow('absent from Head');
 });
});
