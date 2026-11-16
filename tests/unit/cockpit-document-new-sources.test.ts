import {expect,it} from 'vitest';
import {JOURNEY_STAGES,JOURNEY_NODES,JourneyReturnContextSchema,journeyReturnUrl,type OrderJourney} from '@dx-rework/contracts/digital-production-journey';
import {COCKPIT_DOCUMENT_CATEGORIES,createCockpitDocumentSnapshot,loadCockpitDirectoryPages,loadCockpitDocumentCategory as category,loadCockpitDocumentEntry as entry,type CockpitDocumentReader} from '../../apps/web/src/cockpit-documents-model.js';
import {cockpitContext,cockpitQuery,journeyRecordHref} from '../../apps/web/src/digital-journey-cockpit-model.js';
import {quotationHistoryFromSearch} from '../../apps/web/src/quotation-history-route.js';
import {filterDocumentEntries,documentTime} from '../../apps/web/src/cockpit-document-presentation.js';
import {COCKPIT_VISIBLE_DOCUMENT_CATEGORIES} from '../../apps/web/src/cockpit-document-catalog.js';
const sid='00000000-0000-4000-8000-000000000001',oid='00000000-0000-4000-8000-000000000002',line='00000000-0000-4000-8000-000000000003',signal=new AbortController().signal;
const order:OrderJourney={id:sid,sourceId:sid,orderId:oid,designStyleNo:'TEST-DIRECTORY',temporaryStyleNo:null,customer:'TEST',category:null,designer:null,styleName:null,merchandisers:[],orderNumbers:[],createdAt:'2026-11-01T00:00:00Z',deliveryDate:null,selectedRound:1,adoptedRound:1,sourceVersion:1,instructionVersion:1,lines:[{id:line,po:'PO-TEST',color:'黑',formalStyleNo:null,temporaryStyleNo:null,orderedQuantity:100}],links:[],stages:JOURNEY_STAGES.map(s=>({...s,state:'active',nodes:[]})),progress:{development:null,bulk:null},hitReasons:[]};
it('R5 keeps five independent technical entries and removes retired history only from the current directory',()=>{
 const keys=COCKPIT_VISIBLE_DOCUMENT_CATEGORIES.map(item=>item.key);
 for(const key of ['development_plt','development_sizes','development_consumption','customer_comments','customer_final_approval'])expect(keys).toContain(key);
 expect(keys).not.toContain('factory_history');expect(keys).not.toContain('development_technical');
 expect(COCKPIT_DOCUMENT_CATEGORIES.some(item=>item.key==='factory_history')).toBe(true);
});
it('R5 old authorized paper records remain openable without labelling a generic PDF as PLT or borrowing another round',async()=>{
 const read:CockpitDocumentReader=async path=>{
  if(path.includes('/technical/history?'))return {sourceId:sid,roundNumber:1,scopeRef:'整款',enrolled:false,items:[],nextBeforeVersion:null};
  if(path.endsWith('/execution'))return {sheet:{sourceId:sid},tasks:[{taskId:'paper1',taskKind:'development_pattern',routeVersion:1},{taskId:'paper2',taskKind:'development_pattern',routeVersion:2}],facts:[{factId:'first',taskId:'paper1',kind:'纸样完成',recordedAt:'2026-11-01T01:00:00Z',payload:{attachmentIds:['TEST-paper-pdf']}},{factId:'second',taskId:'paper2',kind:'纸样完成',payload:{pltAttachmentIds:['OTHER-ROUND-PLT']}}],routeFacts:[]};
  return {sourceId:sid,roundNumber:1,version:3,document:{unit:'cm',sizes:['M'],measurements:[{name:'胸围',values:['48']}],materials:[{name:'主布',consumption:'1.5',unit:'米'}]}};
 };
 const plt=await category(order,'development_plt',read,signal);expect(plt.state).toBe('unknown');expect(plt.entries[0]?.files?.[0]).toMatchObject({id:'TEST-paper-pdf',name:'原任务附件 1'});expect(plt.entries[0]?.files?.[0]?.path).toContain(sid+'/development/attachments/TEST-paper-pdf');expect(JSON.stringify(plt)).not.toContain('OTHER-ROUND-PLT');
 const sizes=await category(order,'development_sizes',read,signal);expect(sizes.state).toBe('created');expect(sizes.entries[0]?.label).toContain('单据v3');expect(sizes.entries[0]?.children?.[0]?.note).toBe('M：48 cm');
 const usage=await category(order,'development_consumption',read,signal);expect(usage.entries[0]?.children?.[0]?.note).toBe('1.5 米');
 expect((await category(order,'customer_final_approval',read,signal)).state).toBe('unknown');
});
it.each(['development_plt','development_sizes','development_consumption'] as const)('R5 snapshot loader keeps empty %s unfilled even when a draft artifact record exists',async key=>{
 const artifact={artifactSetId:'empty',version:1,sourceId:sid,roundNumber:1,scopeRef:'整款',taskId:'paper',documentVersion:1,status:'draft'};
 const read:CockpitDocumentReader=async path=>{const q=new URL(path,'http://test').searchParams;return {sourceId:sid,roundNumber:1,scopeRef:q.get('scopeRef')??'整款',items:q.get('scopeRef')?.startsWith('po:')?[]:[q.has('version')?{...artifact,body:{pltAttachmentIds:[],consumptionRows:[],baseSizeTable:{sizes:[],measurements:[]}}}:artifact],nextBeforeVersion:null};};
 const whole=await loadCockpitDirectoryPages({...order,lines:[]},key,read,signal);
 expect(whole.state).toBe('missing');expect(whole.entries.length).toBeGreaterThan(0);expect(whole.entries.every(entry=>entry.sourceOnly)).toBe(true);
 const scoped=await loadCockpitDirectoryPages(order,key,read,signal);
 expect(scoped.state).toBe('unknown');expect(scoped.entries.every(entry=>entry.sourceOnly)).toBe(true);
});
it('R5 keeps independent PLT, sizes and usage on exact adopted and older versions without fetching all artifact bodies',async()=>{
 const artifact=(version:number)=>({artifactSetId:'a',version,sourceId:sid,roundNumber:1,scopeRef:'整款',taskId:'paper',documentVersion:1,status:'published'}),calls:string[]=[];
 const read:CockpitDocumentReader=async path=>{calls.push(path);const q=new URL(path,'http://test').searchParams,kind=q.get('kind'),version=Number(q.get('version'));
  const header={sourceId:sid,roundNumber:1,scopeRef:'整款',nextBeforeVersion:!version&&!q.get('beforeVersion')&&kind==='artifacts'?2:null};
  if(kind==='comments')return {...header,items:[]};
  if(q.get('view')==='directory')return {...header,items:[artifact(q.has('beforeVersion')?1:2)]};
  return {...header,items:[{...artifact(version),body:{pltAttachmentIds:['PLT-v'+version],consumptionRows:[{consumption:'1.5',unit:'米'}],baseSizeTable:{unit:'cm',sizes:['M'],measurements:[{name:'胸围',values:['48']}]}}}]};
 };
 const plt=await category(order,'development_plt',read,signal);expect(plt.entries[0]?.files?.[0]?.id).toBe('PLT-v2');expect(plt.entries[0]?.children).toEqual([]);expect(calls.filter(path=>path.includes('version='))).toHaveLength(1);
 const older=await entry(plt.entries.find(item=>item.load?.kind==='technical_history_artifacts')!,read,signal);expect(older.children?.[0]?.load).toMatchObject({kind:'technical_artifact',version:1,part:'plt'});
 const first=await entry(older.children![0]!,read,signal);expect(first.files?.[0]?.id).toBe('PLT-v1');expect(first.children).toEqual([]);
 const sizes=await category(order,'development_sizes',read,signal),usage=await category(order,'development_consumption',read,signal);expect(sizes.entries[0]?.files).toEqual([]);expect(sizes.entries[0]?.children?.map(item=>item.label)).toEqual(['胸围']);expect(usage.entries[0]?.children?.map(item=>item.label)).toEqual(['结构单件用量 1']);
 const denied=Object.assign(Error('原资料权限已撤回'),{status:403});await expect(category(order,'development_plt',async()=>{throw denied;},signal)).rejects.toBe(denied);
});
it('R5 reads each technical kind independently so a failed comment does not hide PLT, sizes or usage',async()=>{
 const artifact={artifactSetId:'independent',version:1,sourceId:sid,roundNumber:1,scopeRef:'整款',taskId:'paper',documentVersion:1,status:'published'},calls:string[]=[];
 const read:CockpitDocumentReader=async path=>{calls.push(path);const q=new URL(path,'http://test').searchParams;if(q.get('kind')==='comments')throw Object.assign(Error('评语暂不可读'),{status:503});return {sourceId:sid,roundNumber:1,scopeRef:'整款',items:[q.has('version')?{...artifact,body:{pltAttachmentIds:['INDEPENDENT-PLT'],consumptionRows:[{consumption:'1.5',unit:'米'}],baseSizeTable:{sizes:['M'],measurements:[{name:'胸围',values:['50']}]}}}:artifact],nextBeforeVersion:null};};
 for(const key of ['development_plt','development_sizes','development_consumption'] as const)expect((await category(order,key,read,signal)).state).toBe('created');expect(calls.every(path=>!path.includes('kind=comments'))).toBe(true);
 await expect(category(order,'customer_comments',read,signal)).rejects.toThrow('评语暂不可读');
 const original=async(path:string)=>path.endsWith('/execution')?Promise.reject(Error('任务读取失败')):path.includes('/technical/history?')?{sourceId:sid,roundNumber:1,scopeRef:'整款',enrolled:false,items:[],nextBeforeVersion:null}:{sourceId:sid,roundNumber:1,version:1,document:{sizes:['M'],measurements:[{name:'胸围',values:['50']}]}};
 expect((await category(order,'development_sizes',original,signal)).state).toBe('created');await expect(category(order,'development_plt',original,signal)).rejects.toThrow('任务读取失败');
});
it('R5 retains exact per-PO technical readers when a whole-style file is absent, without borrowing other scopes',async()=>{
 const calls:string[]=[],scope='po:'+line,artifact={artifactSetId:'po-a',version:1,sourceId:sid,roundNumber:1,scopeRef:scope,taskId:'paper',documentVersion:1,status:'published'};
 const read:CockpitDocumentReader=async path=>{calls.push(path);const q=new URL(path,'http://test').searchParams,selected=q.get('scopeRef');return {sourceId:sid,roundNumber:1,scopeRef:selected,items:q.get('kind')==='artifacts'&&selected===scope?[q.has('version')?{...artifact,body:{pltAttachmentIds:['PO-PLT'],consumptionRows:[],baseSizeTable:{sizes:[],measurements:[]}}}:artifact]:[],nextBeforeVersion:null};};
 const directory=await category(order,'development_plt',read,signal);expect(directory.state).toBe('unknown');expect(calls.every(path=>!path.includes('scopeRef=po'))).toBe(true);
 const scoped=directory.entries.find(item=>item.load?.scopeRef===scope)!;expect(scoped.load?.part).toBe('plt');const loaded=await entry(scoped,read,signal);expect(loaded.children?.[0]?.files?.[0]?.id).toBe('PO-PLT');expect(loaded.children?.[0]?.children).toEqual([]);
 await expect(entry(scoped,async()=>({sourceId:sid,roundNumber:1,scopeRef:'整款',items:[],nextBeforeVersion:null}),signal)).rejects.toThrow('尚不能确认是否已创建');
});
it('classifies every directory with stable stage/node keys and keeps private UI state out of list queries',()=>{
 for(const c of COCKPIT_DOCUMENT_CATEGORIES){expect(JOURNEY_STAGES.some(s=>s.key===c.stage)).toBe(true);expect(JOURNEY_NODES.some(n=>n.key===c.node&&n.stage===c.stage)).toBe(true);}
 const context=JourneyReturnContextSchema.parse({selected:sid,round:1,row:'paper',documentView:'all',documentStage:'preparation',documentSearch:'原图',documentScroll:320,documentFocus:'instruction/published:1/original',documentOpen:'instruction|instruction/published:1'}),url=journeyRecordHref('/ui/digital-production?instruction='+oid,context,'read'),back=new URL(url,'http://test').searchParams.get('returnTo')!;
 expect(cockpitContext(back.split('?')[1]!)).toEqual(context);expect(cockpitQuery(context)).not.toMatch(/document|selected|row|round/);expect(journeyReturnUrl(context)).toContain('documentView=all');
});
it.each(['0','-1','2.5','999999999999','abc',''])('refuses invalid quote history %s instead of falling back to current',version=>{expect(quotationHistoryFromSearch(`?kind=order&id=${oid}&quoteVersion=${version}`,{kind:'order',id:oid}).error).toBeTruthy();});
it('opens only the exact historical quote resource and version',()=>{expect(quotationHistoryFromSearch(`?kind=order&id=${oid}&quoteVersion=2`,{kind:'order',id:oid})).toEqual({version:2});expect(quotationHistoryFromSearch(`?kind=source&id=${sid}&quoteVersion=2`,{kind:'order',id:oid}).error).toBeTruthy();expect(quotationHistoryFromSearch(`?kind=order&id=${oid}&quoteVersion=1&quoteVersion=2`,{kind:'order',id:oid}).error).toBeTruthy();});
it('retains confirmed quotation amounts as the original version without revealing full-cost fields to a partial reader',async()=>{
 const make=(fullCost:boolean)=>({resource:{kind:'order',id:oid},quoteId:'quote',version:3,versions:[2],rows:[{rowId:'row',name:'主布',unit:'米',unitPrice:null,consumption:'1'}],fullCost,document:fullCost?{imageAttachmentIds:[]}:null,confirmation:fullCost?{customerConfirmedTotal:'20',amountScope:'per_piece',taxBasis:'excludes_tax',evidenceNote:'TEST客户确认'}:null});
 const first=await category(order,'quotation',async()=>make(true),signal);expect(first.entries.map(e=>e.label)).toEqual(['当前报价协作 v3','客户确认版 v2']);expect(first.entries[1]!.url).toContain('quoteVersion=2');
 const past=await entry(first.entries[1]!,async()=>({...make(true),version:2}),signal);expect(past.note).toContain('客户确认每件金额 20');await expect(entry(first.entries[1]!,async()=>make(true),signal)).rejects.toThrow();
 const partial=await category(order,'quotation',async()=>make(false),signal);expect(partial.entries).toHaveLength(1);const read=await entry(partial.entries[0]!,async()=>make(false),signal);expect(JSON.stringify(read)).not.toContain('20');expect(read.note).toContain('金额汇总不在当前权限内');
});
it('shows exact technical files, structural use and frozen size rows only after expansion',async()=>{
 const artifact={artifactSetId:'a',version:2,sourceId:sid,roundNumber:1,scopeRef:'整款',taskId:'paper',documentVersion:1,status:'published',createdAt:'2026-11-01T00:00:00Z'},calls:string[]=[];
 const read:CockpitDocumentReader=async path=>{calls.push(path);const q=new URL(path,'http://test').searchParams;if(q.get('view')==='directory')return {sourceId:sid,roundNumber:1,scopeRef:'整款',items:q.get('kind')==='artifacts'?[artifact]:[],nextBeforeVersion:null,effective:{state:'effective',artifactRef:{id:'a',version:2}},contextAvailable:false,adoptedArtifact:artifact};return {sourceId:sid,roundNumber:1,scopeRef:'整款',items:[{...artifact,body:{pltAttachmentIds:['plot'],consumptionRows:[{materialId:'m',consumption:'1.2',unit:'米'}],baseSizeTable:{baseSize:'M',unit:'cm',sizes:['M'],gradingNote:'TEST跳码',templateRef:{id:'template',version:4},measurements:[{pointId:'chest',name:'胸围',values:['48'],tolerance:'1',method:'平量'}]}}}],nextBeforeVersion:null};};
 const data=await category(order,'development_technical',read,signal);expect(calls).toHaveLength(2);expect(JSON.stringify(data)).not.toContain('plot');const chosen=await entry(data.entries[0]!,read,signal);expect(chosen.files?.[0]?.id).toBe('plot');expect(chosen.children?.some(c=>c.note?.includes('M：48'))).toBe(true);expect(chosen.note).toContain('模板 v4');expect(calls.at(-1)).toContain('version=2');
});
it('keeps PO-scoped technical history and exact file expansion in its original scope',async()=>{
 const calls:string[]=[],scopeRef=`po:${line}`;
 const read:CockpitDocumentReader=async path=>{calls.push(path);const q=new URL(path,'http://test').searchParams,scope=q.get('scopeRef')!;return {sourceId:sid,roundNumber:1,scopeRef:scope,items:q.get('kind')==='artifacts'&&scope===scopeRef?[{artifactSetId:'po-artifact',sourceId:sid,version:3,roundNumber:1,scopeRef:scope,status:'published',body:{pltAttachmentIds:['po-plot'],consumptionRows:[],baseSizeTable:{sizes:[],measurements:[]}}}]:[],nextBeforeVersion:null,effective:{state:'pending_review'},contextAvailable:false,adoptedArtifact:null};};
 const data=await category(order,'development_technical',read,signal),po=data.entries.find(e=>e.id===`po-technical:${line}`)!;expect(po.sourceOnly).toBe(true);expect(calls).toHaveLength(2);
 const loaded=await entry(po,read,signal);expect(calls.slice(2).every(p=>new URL(p,'http://test').searchParams.get('scopeRef')===scopeRef)).toBe(true);const artifact=loaded.children![0]!;expect(artifact.label).toContain('v3');const detail=await entry(artifact,read,signal);expect(detail.files?.[0]?.id).toBe('po-plot');expect(new URL(calls.at(-1)!,'http://test').searchParams.get('scopeRef')).toBe(scopeRef);
 await expect(entry(artifact,async()=>({sourceId:sid,roundNumber:1,scopeRef:'整款',items:[],nextBeforeVersion:null}),signal)).rejects.toThrow();
});
it('uses the child source inherited-version authority, never the parent source history or a guessed latest',async()=>{
 const parent='00000000-0000-4000-8000-000000000009',artifact={artifactSetId:'a',version:1,sourceId:parent,roundNumber:1,viaSourceId:sid,viaRoundNumber:2,taskId:'original-task',documentVersion:1,status:'published'};const calls:string[]=[];
 const read:CockpitDocumentReader=async path=>{calls.push(path);return {sourceId:sid,roundNumber:2,scopeRef:'整款',items:[],nextBeforeVersion:null,effective:{state:'pending_review'},contextAvailable:false,adoptedArtifact:artifact};};
 const data=await category({...order,selectedRound:2},'development_technical',read,signal);expect(data.entries[0]!.load?.path).toContain('adoptedArtifactId=a');expect(data.entries[0]!.load?.path).toContain('roundNumber=2');expect(calls.every(c=>!c.includes(parent))).toBe(true);
});
it('projects real readiness history, actual labels, withdrawn versions and private original credentials',async()=>{
 const history=[{recordId:'old',kind:'style_label_ready',version:1,valid:false,state:'ready',operatorName:'TEST仓管',note:'旧版',occurredAt:'2026-11-01T00:00:00Z',evidenceIds:['old-label'],invalidReasons:['已被订正'],quantities:[{name:'款号唛',quantity:60,unit:'枚'}]},{recordId:'new',kind:'style_label_ready',version:2,valid:true,state:'withdrawn',note:'撤回待核',evidenceIds:[],invalidReasons:[],quantities:[]}];
 const data=await category(order,'preparation',async()=>({orderId:oid,preparationId:null,facts:[],tasks:[],readiness:{orderId:oid,history},materials:{history:[]},fabric:{report:null,decision:null}}),signal);expect(data.entries).toHaveLength(2);expect(data.entries[0]!.label).toContain('原版待核对');expect(data.entries[1]!.label).toContain('已撤回');expect(data.entries[0]!.files?.[0]?.path).toContain(`/orders/${oid}/production-readiness/attachments/old-label`);
 await expect(category(order,'preparation',async()=>({orderId:'other',preparationId:null,facts:[],tasks:[]}),signal)).rejects.toThrow('本单不一致');
});
it('retains source/preorder handover evidence before there is a formal order',async()=>{
 const data=await category({...order,orderId:null},'preparation',async()=>({resource:{kind:'source',id:sid},history:[{recordId:'handover',kind:'design_handover',version:1,valid:true,state:'ready',note:'TEST设计交资料',evidenceIds:['receipt']}]}),signal);expect(data.entries[0]!.label).toContain('设计交资料');expect(data.entries[0]!.files?.[0]?.path).toContain(`/sources/${sid}/production-readiness/attachments/receipt`);
});
it('retains every material revision of the same record with its own original evidence',async()=>{
 const history=[{recordId:'same',version:1,kind:'fabric_receipt',valid:false,state:'partial',evidenceIds:['v1-file']},{recordId:'same',version:2,kind:'fabric_receipt',valid:true,state:'ready',evidenceIds:['v2-file']}];
 const data=await loadCockpitDirectoryPages(order,'preparation',async()=>({orderId:oid,preparationId:null,facts:[],tasks:[],readiness:{orderId:oid,history},materials:{history:[]},fabric:{report:null,decision:null}}),signal);
 expect(data.entries.map(e=>e.id)).toEqual(['material:same:1','material:same:2']);expect(data.entries.map(e=>e.files?.[0]?.id)).toEqual(['v1-file','v2-file']);expect(data.entries[0]?.label).toContain('v1');expect(data.entries[1]?.label).toContain('v2');
});
it('opens the exact adopted template version and never substitutes the latest',async()=>{
 const artifactEntry={id:'artifact:a:2',label:'TEST成果',load:{kind:'technical_artifact',id:sid,version:2,round:'1',scopeRef:'整款',path:'original-artifact'}};
 const detail=await entry(artifactEntry,async()=>({sourceId:sid,roundNumber:1,scopeRef:'整款',items:[{artifactSetId:'a',version:2,body:{pltAttachmentIds:[],consumptionRows:[],baseSizeTable:{sizes:[],measurements:[],templateRef:{id:'template',version:1}}}}]}),signal),template=detail.children![0]!;
 expect(template.load?.id).toBe('template');expect(template.load?.path).toContain('/template/versions/1');
 const load=async(version:number)=>({templateId:'template',version,body:{customerCode:'PD',name:'TEST模板',table:{baseSize:'M',unit:'cm',sizes:['M'],measurements:[{name:'胸围',values:[version===1?'48':'52']}],gradingNote:'TEST v'+version}}});
 const old=await entry(template,async()=>load(1),signal);expect(old.children?.[0]?.note).toContain('M：48');await expect(entry(template,async()=>load(2),signal)).rejects.toThrow();
});
it('keeps bulk partial-work evidence and the current adopted round without claiming whole-order cutting',async()=>{
 const data=await category(order,'technical',async()=>({orderId:oid,preparationId:'prep',sourceRound:1,tasks:[],facts:[],readiness:{ranges:[{rangeId:'range',preparationId:'prep',kind:'纸样完成',version:1,lineIds:[line],complete:false,pendingMaterialIds:['accessory'],note:'先做范围',recordedAt:'2026-11-01T00:00:00Z',evidenceIds:['range-file'],basis:{technicalRevision:'frozen'}}]}}),signal);expect(data.entries[0]!.label).toContain('局部范围');expect(data.entries[0]!.note).toContain('PO-TEST');expect(data.entries[0]!.files?.[0]?.path).toContain('range-file');expect(data.note).toContain('不代表整单可开裁');
});
it('uses the actual instruction adopted round even after the source advances or preparation invalidates',async()=>{
 const make=(adoptedRound:number|null)=>({orderId:oid,sourceRound:3,adoptedRound,preparationId:null,tasks:[],facts:[],readiness:{ranges:[{rangeId:'old',evidenceIds:[],lineIds:[line],pendingMaterialIds:[]}]}});
 const data=await category({...order,adoptedRound:2},'technical',async()=>make(1),signal);expect(data.entries.filter(e=>e.load?.kind==='technical_directory').every(e=>e.load?.round==='1')).toBe(true);expect(data.entries.some(e=>e.label.includes('采用开发第 1 轮'))).toBe(true);
 const missing=await category(order,'technical',async()=>make(null),signal);expect(missing.entries.some(e=>e.load?.kind==='technical_directory')).toBe(false);
});
it('keeps lazy expanded files and notes searchable in the authorized snapshot without another read',async()=>{
 let reads=0;const snapshot=createCockpitDocumentSnapshot(order,async()=>{reads++;return {quoteId:'quote',resource:{kind:'order',id:oid},version:1,versions:[],fullCost:true,rows:[{rowId:'r',name:'TEST新加载明细',unit:'米'}],confirmation:{customerConfirmedTotal:'8',amountScope:'order_total',taxBasis:'includes_tax',evidenceNote:'TEST展开后原确认邮件'},document:{imageAttachmentIds:[]}};});
 await snapshot.load('quotation');const before=snapshot.getSnapshot().quotation.data!;expect(filterDocumentEntries(before.entries,'TEST新加载明细')).toHaveLength(0);await snapshot.loadEntry(before.entries[0]!,signal);const after=snapshot.getSnapshot().quotation.data!;expect(filterDocumentEntries(after.entries,'TEST新加载明细')).toHaveLength(1);expect(filterDocumentEntries(after.entries,'TEST展开后原确认邮件')).toHaveLength(1);expect(reads).toBe(1);snapshot.dispose();expect(snapshot.getSnapshot().quotation.data).toBeUndefined();
});
it('normalizes the legacy instruction and budget loaded descriptors before searchable snapshot publication',async()=>{
 for(const kind of ['instruction','budget'] as const){let calls=0;const snapshot=createCockpitDocumentSnapshot(order,async()=>{calls++;return kind==='instruction'?{order:{productionOrderId:oid},version:1,versions:[1],sourceRound:1,document:{images:[{kind:'款图',attachmentId:'image'}]}}:{productionOrderId:oid,version:1,versions:[1],document:{imageAttachmentIds:['image']}};});
  await snapshot.load(kind);const selected=snapshot.getSnapshot()[kind].data!.entries[0]!,loaded=await snapshot.loadEntry(selected,signal);expect(loaded.load).toBeUndefined();const current=snapshot.getSnapshot()[kind].data!.entries[0]!;expect(current.load).toBeUndefined();expect(current.files?.[0]?.id).toBe('image');expect(filterDocumentEntries([current],kind==='instruction'?'款图':'预算图片')).toHaveLength(1);expect(calls).toBe(2);snapshot.dispose();
 }
});
it('groups production progress, native report references and supplemental photos under the original observation',async()=>{
 const data=await category(order,'qc_progress',async()=>({orderId:oid,executions:[{productionId:'production',supplierName:'TEST工厂',records:[{recordId:'photo',revision:2,kind:'photos',relatedProgressRecordId:'observation',recordedAt:'2026-11-02T00:00:00Z',attachmentIds:['second'],observations:[]},{recordId:'observation',revision:1,kind:'progress',collectedAt:'2026-11-01T00:00:00Z',actorName:'TEST QC',observations:[{lineId:line,cuttingPercent:100,sewingPercent:60,ironingPercent:null,additionalFinishedQuantity:2}],attachmentIds:['first'],reportIds:['actual-report']}],lines:[]}],archivedExecutions:[]}),signal);const r=data.entries[0]!.children![0]!;expect(r.id).toBe('observation');expect(r.files?.map(f=>f.id)).toEqual(['first','second']);expect(r.at).toBe('2026-11-01T00:00:00Z');expect(r.children?.[0]?.note).toContain('本次新增成品 2件');expect(r.children?.[1]?.note).toContain('不改变原现场采集时间');
});
it('keeps retired receipt facts only in explicit history while real warehouse dispatch and scoped craft checks remain current',async()=>{
 const read:CockpitDocumentReader=async()=>({orderId:oid,preparationId:'prep',facts:[{factId:'legacy',kind:'到料清点',payload:{}},{factId:'legacy-sample',kind:'船样寄出',payload:{}},{factId:'send',kind:'仓库实际发厂',payload:{lines:[{lineId:line,quantity:80}]}}],checks:[],shipSamples:[{eventId:'sample',trackingNumber:'TRACK-1',lineIds:[line],operatorName:'TEST跟单'}]});
 expect((await category(order,'factory',read,signal)).entries.map(e=>e.id)).toEqual(['send']);expect((await category(order,'factory_history',read,signal)).entries.map(e=>e.id)).toEqual(['legacy']);const samples=await category(order,'ship_sample',read,signal);expect(samples.entries[0]?.label).toContain('TRACK-1');expect(samples.entries[0]?.note).toContain('PO-TEST');
});
it('does not treat an associated receiving batch as an actual receipt or packing fact',async()=>{
 const read:CockpitDocumentReader=async()=>({orderId:oid,lines:[{lineId:line,receivingBatchId:'batch'}],closed:null,quality:[]});
 for(const kind of ['receiving','packing'] as const){const data=await category(order,kind,read,signal);expect(data.state).toBe('unknown');expect(data.entries[0]?.sourceOnly).toBe(true);}
});
it('reads factory garment inspection history separately from craft-QC and keeps quantity-change invalidation',async()=>{
 const raw={orderId:oid,lines:[{lineId:line,receivingBatchId:'batch'}],closed:null,quality:[{receiptId:'receipt',lineId:line,quantity:8,inspected:false,priorInspection:true}]},data=await category(order,'receiving',async()=>raw,signal);expect(data.entries.some(e=>e.label.includes('原检查待复核'))).toBe(true);
 const checks=data.entries.find(e=>e.id==='factory-garment-checks')!,loaded=await entry(checks,async()=>({orderId:oid,productionInspectionHistory:[{eventId:'garment',operator:'TEST QC',checks:[{lineId:line,allocationQuantity:100,result:'需处理',problem:'线头'}]}],productionChecks:[],checks:[{checkId:'craft-only',attachmentIds:[]}]}),signal);expect(loaded.children?.[0]?.id).toBe('garment');expect(JSON.stringify(loaded)).not.toContain('craft-only');
});
it('labels original QC time verification as verification and does not manufacture another quality result',async()=>{
 const loaded=await entry({id:'receipt-quality-history',label:'TEST history',load:{kind:'order_events_quality',path:`digital-production/orders/${oid}/closure/history`,id:oid}},async()=>({orderId:oid,family:'receipt_quality',nextBeforeId:null,items:[{eventId:'TEST verified',kind:'garment_receipt_qc_time_verified',occurredAt:'2026-11-01T00:00:00.123Z',recordedAt:'2026-11-02T00:00:00.456Z',operatorName:'TEST Root',payload:{reason:'TEST original time independently checked'}}]}),signal);
 expect(loaded.children?.[0]).toMatchObject({label:'原到仓检查时间核实',at:'2026-11-01T00:00:00.123Z'});
 expect(loaded.children?.[0]?.note).toContain('TEST original time independently checked');expect(loaded.children?.[0]?.note).not.toContain('当次合格');
});
it('rejects a mismatched receiving/packing group and preserves date-only precision',async()=>{
 const e={id:'batch',label:'TEST批次',load:{kind:'receiving',path:'receiving/batches/batch/document-history',id:'batch'}};await expect(entry(e,async()=>({batchIds:['other'],files:[],receipts:[],corrections:[],packing:[],resolutions:[]}),signal)).rejects.toThrow('批次与本单不一致');
 const r=await entry(e,async()=>({batchIds:['batch'],files:[],receipts:[{receiptId:'receipt',receivedAt:null,receivedDate:'2026-11-01',actualQuantity:5,defectiveQuantity:0}],corrections:[],packing:[],resolutions:[]}),signal);expect(documentTime(r.children![0]!.at!)).toBe('2026-11-01');expect(documentTime('2026-11-01')).not.toContain('08:00');
});
it('preserves inhouse finishing as its real original history without manufacturing responsibility or finance nodes',async()=>{
 const item={id:'tail',label:'TEST做尾',url:'/ui/tasks/tail',load:{kind:'rework',path:'rework-orders/tail/business-detail',id:'tail'}};const read=await entry(item,async()=>({reworkOrderId:'tail',reworkNo:'TEST-T',version:2,reworkKind:'inhouse_finishing',canReadBusinessDetails:false,attachments:[{attachmentId:'photo',filename:'原凭证.jpg'}],workflowHistory:[{action:'原IE数量复核',handledAt:'2026-11-01T00:00:00Z',handledBy:'TEST IE'}]}),signal);expect(read.label).toContain('本厂做尾');expect(read.children).toHaveLength(1);expect(JSON.stringify(read)).not.toMatch(/owner_signature|settlement_ledger/);
});
it('filters only authorized, already-loaded metadata and never mutates original entries or supplies fake missing records',()=>{
 const original=[{id:'record',label:'尺寸',children:[{id:'photo',label:'历史',files:[{id:'file',name:'TEST超长原凭证'.repeat(20),path:'private/path'}]}]}];const filtered=filterDocumentEntries(original,'超长');expect(filtered[0]?.children).toHaveLength(1);expect(filterDocumentEntries(original,'未载入')).toEqual([]);expect(original[0]!.children).toHaveLength(1);
});

it('does not promote a source-only closure/quality entry into an existing business record while aggregating pages',async()=>{
 const read:CockpitDocumentReader=async()=>({orderId:oid,lines:[],closed:null,quality:[]});
 for(const key of ['closure','receiving'] as const){const data=await loadCockpitDirectoryPages(order,key,read,signal);expect(data.state).toBe('unknown');expect(data.entries.every(e=>e.sourceOnly)).toBe(true);}
});

it('keeps actual customer approval date distinct from registration in original document history',async()=>{
 const make=(known:boolean)=>async()=>({sourceId:sid,roundNumber:1,scopeRef:'整款',enrolled:true,items:[{commentId:'customer-date',version:1,isFinal:true,decision:'approved',occurredAt:null,occurredDate:known?'2026-11-09':null,recordedAt:'2026-11-15T03:00:00Z'}],nextBeforeVersion:null});
 const dated=await category(order,'customer_final_approval',make(true),signal),unknown=await category(order,'customer_final_approval',make(false),signal);
 expect(dated.entries[0]).toMatchObject({at:'2026-11-09',metadata:[{label:'客户实际反馈',at:'2026-11-09'},{label:'原评语登记',at:'2026-11-15T03:00:00Z'}]});
 expect(documentTime(dated.entries[0]!.at!)).toBe('2026-11-09');expect(unknown.entries[0]!.at).toBe('');
 expect(unknown.entries[0]!.metadata![0]!.at).toBe('');
});
