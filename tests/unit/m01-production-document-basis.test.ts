import {expect,it} from 'vitest';
import {JOURNEY_STAGES,type OrderJourney} from '@dx-rework/contracts/digital-production-journey';
import {loadCockpitDocumentCategory as category,loadCockpitDocumentEntry as load,type CockpitDocumentReader} from '../../apps/web/src/cockpit-documents-model.js';
const sid='00000000-0000-4000-8000-000000000001',oid='00000000-0000-4000-8000-000000000002',aid='00000000-0000-4000-8000-000000000003';
const signal=new AbortController().signal;
const order:OrderJourney={id:sid,sourceId:sid,orderId:oid,designStyleNo:'TEST-P03',temporaryStyleNo:null,customer:'TEST',category:null,designer:null,styleName:null,merchandisers:[],orderNumbers:[],createdAt:'2026-11-01T00:00:00Z',deliveryDate:null,selectedRound:2,adoptedRound:1,sourceVersion:5,instructionVersion:6,lines:[],links:[],stages:JOURNEY_STAGES.map(s=>({...s,state:'active',nodes:[]})),progress:{development:null,bulk:null},hitReasons:[]};
const basis=(round=1)=>({instructionVersion:6,sourceId:sid,sourceRound:round,publishedAt:'2026-11-02T00:00:00Z',technicalArtifact:{id:aid,version:1,sourceId:sid,roundNumber:1,scopeRef:'整款'},technicalBasisState:'recorded'});
const bulk=(publishedBasis:unknown)=>({orderId:oid,preparationId:null,sourceRound:3,adoptedRound:1,tasks:[],facts:[],instructionValid:false,publishedBasis});
const artifact=(inherited=false)=>({artifactSetId:aid,sourceId:sid,roundNumber:1,scopeRef:'整款',version:1,documentVersion:1,status:'published',createdAt:'2026-11-01T00:00:00Z',...(inherited?{viaSourceId:sid,viaRoundNumber:2,inheritedAt:'2026-11-02T00:00:00Z'}:{})});
it('P03-01: keeps the published production basis readable after latest development invalidates current preparation',async()=>{
 const data=await category(order,'technical',async()=>bulk(basis()),signal),selected=data.entries[0]!;
 expect(selected.label).toContain('制单第 6 版');expect(selected.url).toContain('instructionVersion=6');expect(selected.load).toMatchObject({id:sid,round:'1',productionArtifact:{id:aid,version:1}});
 const calls:string[]=[],read:CockpitDocumentReader=async path=>{calls.push(path);return {sourceId:sid,roundNumber:1,scopeRef:'整款',items:[artifact()],adoptedArtifact:{...artifact(),version:2},nextBeforeVersion:null};};
 const frozen=await load(selected,read,signal);expect(frozen.children?.[0]?.id).toBe(`artifact:${aid}:1`);expect(calls).toHaveLength(1);expect(calls[0]).toContain('version=1');expect(calls[0]).not.toContain('roundNumber=3');expect(frozen.children?.[0]?.load?.path).toContain('version=1');
 await expect(load(selected,async()=>({sourceId:sid,roundNumber:1,scopeRef:'整款',items:[{...artifact(),version:2}]}),signal)).rejects.toThrow('精确成果版本');
});
it('P03-02: separates round2/document5/instruction6 from inherited round1 artifact1 and its two original times',async()=>{
 const development=await category(order,'development',async path=>path.endsWith('/rounds')?{rounds:[{roundNumber:2}],draft:null}:{sourceId:sid,roundNumber:2,version:5,status:'published',document:{files:[]}},signal);
 expect(development.entries[0]?.label).toContain('第 2 轮 · 单据 v5');
 const instructions=await category(order,'instruction',async()=>({order:{productionOrderId:oid},version:7,publishedVersion:6,versions:[6,4],document:{images:[]}}),signal);
 expect(instructions.entries.map(e=>e.label)).toEqual(['尚未生效 · 大货制单草稿第 7 版','生产当前采用 · 大货制单第 6 版','已发布历史 · 大货制单第 4 版']);
 const directory=await category(order,'technical',async()=>bulk(basis(2)),signal),paths:string[]=[];
 const chosen=await load(directory.entries[0]!,async path=>{paths.push(path);return {sourceId:sid,roundNumber:2,scopeRef:'整款',items:[artifact(true)],nextBeforeVersion:null};},signal);
 const item=chosen.children![0]!;expect(item.label).toContain('第 1 轮技术成果 v1');expect(item.metadata).toEqual([{label:'原成果发布时间',at:'2026-11-01T00:00:00Z',by:''},{label:'本轮沿用时间',at:'2026-11-02T00:00:00Z',by:''}]);
 expect(paths[0]).toContain('roundNumber=2');expect(paths[0]).toContain('adoptedArtifactId='+aid);expect(paths[0]).toContain('view=directory');
 expect(item.load?.path).toContain('adoptedArtifactId='+aid);expect(directory.entries[0]?.metadata?.[0]?.label).toBe('本版制单发布时间');
});
it('P03-01/04: pins the frozen source and rejects a denial without reading a newer source',async()=>{
 const other='00000000-0000-4000-8000-000000000009',data=await category({...order,sourceId:other},'technical',async()=>bulk(basis()),signal),calls:string[]=[];
 await expect(load(data.entries[0]!,async path=>{calls.push(path);throw Object.assign(Error('TEST original denied'),{status:403});},signal)).rejects.toMatchObject({status:403});
 expect(calls).toHaveLength(1);expect(calls[0]).toContain('/sources/'+sid+'/');expect(calls[0]).not.toContain(other);
});
it('P03-01/04: preserves published instruction access but exposes no source descriptor when source permission is absent',async()=>{
 const data=await category(order,'technical',async()=>bulk({...basis(),sourceId:null,technicalArtifact:null,technicalBasisState:'restricted'}),signal);
 expect(data.entries).toHaveLength(1);expect(data.entries[0]?.url).toContain('instructionVersion=6');expect(data.entries[0]?.load).toBeUndefined();expect(data.entries[0]?.note).toContain('无权读取');expect(JSON.stringify(data)).not.toContain(aid);
 const missing=await category(order,'technical',async()=>bulk({...basis(),technicalArtifact:null,technicalBasisState:'missing'}),signal);expect(missing.entries[0]?.note).toContain('不能以最新成果替代');expect(missing.entries[0]?.load).toBeUndefined();
});
it('P03-03: retains zero-record retired factories separately without assigning them current obligations',async()=>{
 const data=await category(order,'qc_progress',async()=>({orderId:oid,executions:[{productionId:'native',factoryDecisionId:'current',supplierName:'TEST新厂',lines:[],records:[]}],archivedExecutions:[{productionId:'native',factoryDecisionId:null,supplierName:'TEST旧厂',currentQuantity:0,records:[]},{productionId:'native',factoryDecisionId:'unknown',supplierName:'TEST范围待核',currentQuantity:null,records:[]}]}),signal);
 expect(data.entries).toHaveLength(3);expect(data.entries[1]?.label).toContain('已退出的工厂记录');expect(data.entries[1]?.note).toContain('当前份额0件');expect(data.entries[1]?.note).toContain('未记录QC');expect(data.entries[1]?.note).toContain('不计入当前报量、监督或待办');expect(data.entries[2]?.note).toContain('当前范围待核');expect(data.entries[2]?.note).not.toContain('份额0');
});
it('P03-04: refuses a different order or a changed saved draft instead of displaying it under the original label',async()=>{
 const data=await category(order,'instruction',async()=>({order:{productionOrderId:oid},version:7,publishedVersion:6,versions:[6],document:{images:[]}}),signal),draft=data.entries[0]!;
 expect(draft.load?.version).toBe(7);
 await expect(load(draft,async()=>({order:{productionOrderId:oid},version:8,document:{images:[]}}),signal)).rejects.toThrow('所选历史版本');
 await expect(load(draft,async()=>({order:{productionOrderId:sid},version:7,document:{images:[]}}),signal)).rejects.toThrow('本单不一致');
});
it('P03-01/05: labels only a real saved revision draft and never invents an approval or a published next round',async()=>{
 const data=await category(order,'development',async path=>path.endsWith('/rounds')?{rounds:[{roundNumber:2}],draft:{version:3,payload:{basedOnRound:2}}}:{sourceId:sid,roundNumber:2,version:5,status:'published',document:{files:[]}},signal);
 expect(data.entries[0]?.label).toContain('尚未生效 · 开发复版草稿第 3 版');expect(data.entries[0]?.note).toContain('基于开发第 2 轮');expect(data.entries.slice(1).map(e=>e.load?.version)).toEqual([2,1]);expect(JSON.stringify(data)).not.toContain('老板批');
});
