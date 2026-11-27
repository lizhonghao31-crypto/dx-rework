import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {affectedEntryPlan,affectedReceipt,parseAffectedReceipt,AFFECTED_PREFIX,requireAffectedCases,vitestCases} from './affected-entry-preflight.mjs';

const registry=JSON.parse(readFileSync(new URL('./affected-entry-map.json',import.meta.url)));
const plan={repository:'lizhonghao31-crypto/dx-rework',kind:'full',pr:99,head:'a'.repeat(40),base:'b'.repeat(40),baseRef:'release/digital-production-v1'};
const run={id:111,run_attempt:1};
const selected=affectedEntryPlan(registry,['apps/web/src/digital-development-create-form.tsx']);

test('creation changes require the numbered browser and the three actually affected older entries',()=>{
 assert.deepEqual(selected.map(c=>c.id),['original-fixed-timeline-creation','original-numbered-creation','original-preorder-conversion','original-preorder-investment-from-task']);
 const numbered=selected.find(c=>c.id==='original-numbered-creation');
 assert.throws(()=>requireAffectedCases(selected,[{...numbered,status:'passed'}]),
  e=>e.message.includes('original-fixed-timeline-creation')&&e.message.includes('original-preorder-investment-from-task')&&e.message.includes('original-preorder-conversion'));
 assert.doesNotThrow(()=>requireAffectedCases(selected,selected.map(c=>({...c,status:'passed'}))));
});

test('unrelated QC and quote work does not request the creation or preorder tests',()=>{
 assert.deepEqual(affectedEntryPlan(registry,['apps/api/src/production-platform/rework-service.ts','apps/api/src/production-platform/customer-quotation-service.ts']),[]);
 assert.deepEqual(affectedEntryPlan(registry,['apps/web/src/independent-craft-field.tsx']).map(t=>t.id),['original-fixed-timeline-creation']);
 assert.deepEqual(affectedEntryPlan(null,['apps/web/src/digital-development-create-form.tsx']),[]);
});

test('wrong original file, skip, fail and duplicated matches cannot replace a passing case',()=>{
 const [target]=selected;
 for(const results of [
  [{...target,file:'tests/wrong.ts',status:'passed'}],
  [{...target,status:'pending'}],
  [{...target,status:'skipped'}],
  [{...target,status:'failed'}],
  [{...target,status:'passed'},{...target,status:'passed'}]
 ])assert.throws(()=>requireAffectedCases([target],results),/AFFECTED_ENTRY_PROOF_MISSING/);
 const actual=vitestCases({testResults:[{name:'/tmp/candidate/'+target.file,assertionResults:[{fullName:target.name,status:'passed'}]}]},'/tmp/candidate');
 assert.doesNotThrow(()=>requireAffectedCases([target],actual));
});

test('only the actual hosted job’s same run and attempt / Head / Base / exact cases can certify',()=>{
 const good=affectedReceipt(plan,run,selected,'3'.repeat(64));
 const parse=receipt=>parseAffectedReceipt('timestamp '+AFFECTED_PREFIX+JSON.stringify(receipt),plan,run,selected);
 assert.deepEqual(parse(good),good);
 for(const patch of [{head:'d'.repeat(40)},{base:'d'.repeat(40)},{pr:999},{attempt:2},{runId:99},{cases:[]},{reportSha256:null}])
  assert.throws(()=>parse({...good,...patch}));
 assert.throws(()=>parseAffectedReceipt('',plan,run,selected),/Expected one/);
 assert.throws(()=>parseAffectedReceipt([1,2].map(()=>AFFECTED_PREFIX+JSON.stringify(good)).join('\n'),plan,run,selected),/Expected one/);
 const empty=affectedReceipt(plan,run,[],null);
 assert.deepEqual(parseAffectedReceipt(AFFECTED_PREFIX+JSON.stringify(empty),plan,run,[]),empty);
});

test('malformed base profile does not become no impact',()=>{
 for(const bad of [{version:2,entries:registry.entries},{version:1,entries:[]},{version:1,entries:[{...registry.entries[0],file:'../../outside.test.ts'}]},
   {version:1,entries:[registry.entries[0],registry.entries[0]]}]) assert.throws(()=>affectedEntryPlan(bad,[]),/Invalid pinned/);
});
