import type{OrderJourney}from'@dx-rework/contracts/digital-production-journey';
import{row,rows,str,strings,checkedRows,sameEntity,check,original,file,type CockpitDocumentReader,type CockpitDocumentEntry,type CockpitDocumentResult}from'./cockpit-document-data.js';

/** Original authorized development/execution records, never fabricated
 * technical versions. Untyped task attachments do not prove PLT existence. */
export async function legacyDevelopmentDirectory(order:Pick<OrderJourney,'sourceId'|'selectedRound'>,read:CockpitDocumentReader,signal:AbortSignal,scope:string,part?:'plt'|'sizes'|'consumption'|'comment'|'final'):Promise<CockpitDocumentResult>{
 const sid=order.sourceId!,round=order.selectedRound??1;
 if(scope!=='整款')return {legacy:true,state:'unknown',entries:[],note:'原单没有分开登记这张PO的技术成果。'};
 const fromSheet=!part||part==='sizes'||part==='consumption',fromExecution=!part||!fromSheet;
 const [sheet,execution]=await Promise.all([fromSheet?read(`digital-production/sources/${sid}/development?round=${round}`,signal).then(row):null,fromExecution?read(`digital-production/sources/${sid}/execution`,signal).then(row):null]);
 if(sheet){sameEntity(sheet,'sourceId',sid,'原开发资料');check((sheet.roundNumber??1)===round);}if(execution)sameEntity(row(execution.sheet),'sourceId',sid,'原办理资料');
 const document=row(sheet?.document),tasks=execution?checkedRows(execution.tasks):[],ids=new Set(tasks.filter(task=>task.routeVersion===round).map(task=>str(task.taskId)));
 const sourceFacts=execution?[...checkedRows(execution.facts),...checkedRows(execution.routeFacts)].filter(fact=>ids.has(str(fact.taskId))||fact.routeVersion===round||row(fact.payload).routeVersion===round):[];
 const entries:CockpitDocumentEntry[]=[];
 for(const fact of sourceFacts){
  const payload=row(fact.payload),kind=str(fact.kind),task=tasks.find(task=>task.taskId===fact.taskId),pattern=task?.taskKind==='development_pattern'||/纸样/.test(kind),part=kind.includes('最终批复')?'final':/客户.*评语|客户.*反馈/.test(kind)?'comment':pattern?'legacy_pattern':null;
  if(!part)continue;const ids=[...new Set([...strings(payload.attachmentIds),...strings(payload.imageAttachmentIds)])],plt=strings(payload.pltAttachmentIds);
  const entry:CockpitDocumentEntry={id:'legacy:'+str(fact.factId),technicalPart:part,label:kind||'原纸样办理记录',note:str(payload.note)||undefined,at:str(fact.recordedAt),url:fact.taskId?`/ui/digital-production?task=${fact.taskId}&taskView=read`:original('development',sid,round),files:ids.map((id,index)=>file(id,`原任务附件 ${index+1}`,`digital-production/sources/${sid}/development/attachments/${encodeURIComponent(id)}`))};
  entries.push(entry);
  if(plt.length)entries.push({...entry,id:entry.id+':plt',technicalPart:'plt',label:'原纸样PLT',files:plt.map((id,index)=>file(id,`PLT纸样原件 ${index+1}`,`digital-production/sources/${sid}/development/attachments/${encodeURIComponent(id)}`))});
 }
 const sizes=strings(document.sizes),measurements=rows(document.measurements);
 if(measurements.length)entries.push({id:'legacy:document-sizes',technicalPart:'sizes',label:`开发单原尺寸 · 单据v${sheet!.version}`,url:original('development',sid,round),children:measurements.map((m,index)=>({id:'measurement:'+index,label:str(m.name),note:sizes.map((size,n)=>`${size}：${strings(m.values)[n]??'未填写'}`).join('；')+(document.unit?' '+str(document.unit):'')}))});
 const usage=rows(document.materials).filter(material=>str(material.consumption).trim());
 if(usage.length)entries.push({id:'legacy:document-usage',technicalPart:'consumption',label:`开发单单件用量 · 单据v${sheet!.version}`,url:original('development',sid,round),children:usage.map((m,index)=>({id:'consumption:'+index,label:str(m.name)||str(m.label)||'原物料',note:str(m.consumption)+(m.unit?' '+str(m.unit):'')}))});
 return {legacy:true,state:entries.length?'created':'unknown',entries,note:'原单尚未采用技术版本，以下保留原开发单和办理成果。'};
}

export function legacyDevelopmentPart(directory:CockpitDocumentResult,part:'plt'|'sizes'|'consumption'|'comment'|'final'):CockpitDocumentResult{
 const entries=directory.entries.filter(entry=>entry.technicalPart===part);
 if(entries.length)return {...directory,state:'created',entries};
 const originals=part==='plt'?directory.entries.filter(entry=>entry.technicalPart==='legacy_pattern'):[];
 return {state:'unknown',entries:originals.map(entry=>({...entry,sourceOnly:true})),note:part==='plt'&&originals.length?'原纸样成果未单独标明PLT，请打开原件核对。':'原单没有单独登记此项，请在原资料核对。'};
}
