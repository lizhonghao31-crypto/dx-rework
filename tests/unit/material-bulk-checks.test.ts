import {describe,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {materialBulkRules} from '../../apps/api/src/production-platform/development-material-check-rules.js';
import {assertMaterialChecks} from '../../apps/api/src/production-platform/development-material-verification.js';
import {materialBulkCounts,selectMaterialField} from '../../apps/web/src/development-material-bulk.js';
import {initialDevelopmentDocument} from '../../apps/web/src/digital-development-editing.js';
import {SaveMaterialVerificationSchema,type MaterialVerificationEntry,type MaterialVerification} from '@dx-rework/contracts/digital-development-execution';
const fixture=()=>{
 const doc=initialDevelopmentDocument();doc.materials=[0,1,2,3,4,5,6].map((_,i)=>({...doc.materials[0]!,materialId:randomUUID(),name:`TEST材料${i}`,specification:'TEST规格',color:'深蓝',quantity:'2米',available:true}));
 const entries:MaterialVerificationEntry[]=doc.materials.map((m,i)=>({materialId:m.materialId,usage:i===1?'pending':i===2?'unused':'use',physical:i===3,quantity:false,color:false,specification:false,confirmedWith:i===2?'TEST设计师':'',note:i===2?'TEST不用':''}));
 return {doc,entries};
};
describe('material checks batch facts and draft boundary',()=>{
 it('selects only eligible unchecked cells across the whole page, preserving all other dimensions and usage',()=>{
  const {doc,entries}=fixture(),rules=materialBulkRules(doc,null,[],[],[]),before=structuredClone(entries);
  const selected=selectMaterialField(entries,'physical',rules,[]);
  expect(selected.selected).toEqual([entries[0]!.materialId,entries[4]!.materialId,entries[5]!.materialId,entries[6]!.materialId]);
  expect(materialBulkCounts(entries,'physical',rules,[])).toEqual({checked:1,selectable:4,excluded:2});
  expect(entries).toEqual(before);expect(selected.entries[1]).toBe(entries[1]);expect(selected.entries[2]).toBe(entries[2]);
  expect(selected.entries.every((row,i)=>row.usage===before[i]!.usage&&!row.quantity&&!row.color&&!row.specification&&row.note===before[i]!.note)).toBe(true);
  expect(selectMaterialField(selected.entries,'physical',rules,[]).selected).toEqual([]);
 });
 it('excludes missing physical, missing comparison basis, known returned mismatch and unresolved quality without inventing mismatch from false',()=>{
  const {doc,entries}=fixture(),m=doc.materials[0]!;m.available=false;m.color='';
  const rules=materialBulkRules(doc,{kind:'缺项退回',items:[{materialId:m.materialId,physical:false}],at:'2026-10-20T10:00:00Z'},[],[{materialId:m.materialId,field:'specification',need:'supply',reason:'TEST规格错误'}],[{materialIds:[doc.materials[4]!.materialId]}]);
  expect(rules[0]!.checks.physical).toMatchObject({canSelect:false,knownConflict:true});
  expect(rules[0]!.checks.quantity).toMatchObject({canSelect:true,knownConflict:false});
  expect(rules[0]!.checks.color).toMatchObject({canSelect:false,knownConflict:false});
  expect(rules[0]!.checks.specification).toMatchObject({canSelect:false,knownConflict:true});
  expect(rules[4]!.checks.quantity.canSelect).toBe(false);expect(rules[5]!.checks.quantity.canSelect).toBe(true);
  expect(selectMaterialField(entries,'physical',rules,[]).selected).not.toContain(m.materialId);
  const arrived=materialBulkRules(doc,{kind:'核配通过',items:[{materialId:m.materialId,physical:false}],at:'2026-10-20T10:00:00Z'},[{materialId:m.materialId,at:'2026-10-20T11:00:00Z'}],[],[]);
  expect(arrived[0]!.checks.physical.canSelect).toBe(true);
 });
 it('does not override local recorded issues, pending/unused rows, or unavailable rule projections',()=>{
  const {doc,entries}=fixture(),m=doc.materials[0]!,rules=materialBulkRules(doc,null,[],[],[]);
  expect(selectMaterialField(entries,'color',rules,[{materialId:m.materialId,field:'color',need:'supply',reason:'TEST色差'}]).selected).not.toContain(m.materialId);
  expect(selectMaterialField(entries,'color',undefined,[]).selected).toEqual([]);
 });
 it('revalidates bulk intent and manual known conflicts server-side without converting draft to applied facts',()=>{
  const {doc,entries}=fixture(),rules=materialBulkRules(doc,null,[],[],[]),verification={bulkRules:rules} as MaterialVerification;
  const picked=selectMaterialField(entries,'color',rules,[]);
  expect(()=>assertMaterialChecks(verification,picked.entries,picked.selected.map(materialId=>({materialId,field:'color'})))).not.toThrow();
  expect(()=>assertMaterialChecks(verification,entries,[{materialId:entries[1]!.materialId,field:'color'}])).toThrow('批量范围');
  rules[0]!.checks.color={canSelect:false,knownConflict:true,reason:'TEST已记录颜色不符'};
  expect(()=>assertMaterialChecks(verification,picked.entries)).toThrow('TEST已记录颜色不符');
  const body={taskId:randomUUID(),expectedVersion:0,expectedDocumentVersion:1,entries,bulkChecks:[{materialId:entries[0]!.materialId,field:'color'}]};
  expect(SaveMaterialVerificationSchema.safeParse({...body,bulkChecks:[...body.bulkChecks,...body.bulkChecks]}).success).toBe(false);
 });
});
