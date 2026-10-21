import {useEffect,useRef,useState} from 'react';
import {Button} from '@dx-rework/ui';
import type {DigitalTask} from '@dx-rework/contracts/digital-production-tasks';
import type {DevelopmentReturnIssue} from '@dx-rework/contracts/digital-development-amendments';
import {MATERIAL_CHECK_FIELDS,MATERIAL_CHECK_LABELS,type MaterialCheckField,type MaterialVerificationEntry} from '@dx-rework/contracts/digital-development-execution';
import type {useDevelopmentExecution} from './digital-development-execution-panel.js';
import {DevelopmentReturnIssues} from './development-return-issues.js';
import {useDigitalDetailNavigationGuard} from './use-digital-detail-navigation-guard.js';
import {WorkbenchAction} from './workbench-action.js';
import {materialCellEligibility,materialBulkCounts,selectMaterialField,cleanMaterialEntries} from './development-material-bulk.js';
import './development-material-verification.css';
export function DevelopmentMaterialVerification({controller,task}:{controller:ReturnType<typeof useDevelopmentExecution>;task:DigitalTask}){
 const {state,busy,run}=controller,verification=state!.materialVerification!;
 const [returnIssues,setReturnIssues]=useState<DevelopmentReturnIssue[]>(verification.returnIssues??[]);
 const [entries,setEntries]=useState<MaterialVerificationEntry[]>(verification.entries),[note,setNote]=useState(verification.note),[returning,setReturning]=useState(verification.result==='缺项退回');
 const [phase,setPhase]=useState<'idle'|'saving'|'saved'|'checking'|'check-incomplete'>('idle');
 const bulk=useRef<Array<{materialId:string;field:MaterialCheckField}>>([]),submitting=useRef(false);
 useEffect(()=>{setReturnIssues(verification.returnIssues??[]);setEntries(verification.entries);setNote(verification.note);setReturning(verification.result==='缺项退回');bulk.current=[];},[verification.version,verification.documentVersion,task.taskId]);
 const result=returning?'缺项退回':'通过';
 const dirty=JSON.stringify([cleanMaterialEntries(entries),note,result,returnIssues])!==JSON.stringify([cleanMaterialEntries(verification.entries),verification.note,verification.result,verification.returnIssues??[]]);
 useDigitalDetailNavigationGuard(dirty&&!controller.uncertainWrite&&!controller.checkReceipt,busy,controller.writing,'核料输入尚未保存，确定离开？');
 const locked=busy||controller.uncertainWrite;
 const change=(id:string,patch:Partial<MaterialVerificationEntry>)=>{bulk.current=bulk.current.filter(item=>item.materialId!==id||(!('usage' in patch)&&!(item.field in patch)));setEntries(rows=>rows.map(row=>row.materialId===id?{...row,...patch}:row));};
 const selectAll=(field:MaterialCheckField)=>{
  const next=selectMaterialField(entries,field,verification.bulkRules,returnIssues);setEntries(next.entries);
  bulk.current=[...bulk.current.filter(item=>item.field!==field||!next.selected.includes(item.materialId)),...next.selected.map(materialId=>({materialId,field}))];
 };
 const save=async()=>{
  setPhase('saving');
  const saved=await run('material-verification',{bulkChecks:bulk.current,returnIssues,note,result,taskId:task.taskId,expectedDocumentVersion:verification.documentVersion,expectedVersion:verification.version,entries:cleanMaterialEntries(entries)});
  setPhase(saved?'saved':'idle');return saved;
 };
 const submit=async()=>{
  if(submitting.current||locked)return;submitting.current=true;
  try{
   const saved=await save();if(!saved?.materialVerification)return;setPhase('checking');
   const checked=await run('check',{returnIssues,taskId:task.taskId,expectedVerificationVersion:saved.materialVerification.version,result,note,items:saved.materialVerification.entries.filter(row=>row.usage==='use').map(({materialId,physical,quantity,color,specification})=>({materialId,physical,quantity,color,specification}))});
   setPhase(checked?'idle':'check-incomplete');
  }finally{submitting.current=false;}
 };
 if(controller.checkReceipt)return <p role="status">核料已完成。{controller.navigationFailed?'委派页暂未打开，请重新打开；无需再次提交核料。':'正在打开本轮委派页…'}<a href={controller.checkReceipt.target}>打开本轮委派页</a></p>;
 return <form className="development-material-check-form development-material-verification" onSubmit={e=>{e.preventDefault();void submit();}}>
  <header><h3>核对本轮材料</h3><p>先确认本轮使用情况，再核对四项。保存只保留输入，提交才生效。</p></header>
  <fieldset disabled={locked}>
   <section className="material-bulk-controls" aria-label="分项全选">
    {MATERIAL_CHECK_FIELDS.map(field=>{const counts=materialBulkCounts(entries,field,verification.bulkRules,returnIssues);return <div key={field}><strong>{MATERIAL_CHECK_LABELS[field]}</strong><Button type="button" disabled={locked||!counts.selectable} aria-label={`${MATERIAL_CHECK_LABELS[field]}全选`} onClick={()=>selectAll(field)}>全选</Button><small>已勾 {counts.checked} · 可补选 {counts.selectable} · 排除 {counts.excluded}</small></div>;})}
   </section>
   <p className="material-bulk-scope">全选范围：本轮整页已确认使用且适用的材料，包含下方全部材料。每次只补选一项，不改用途、不覆盖已记录问题；各材料旁可查看排除原因。</p>
   {!verification.bulkRules&&<p role="status">批量核对依据未就绪，请重新读取本页；不会代您判定材料相符。</p>}
   <div className="material-verification-list">{state!.sheet.document!.materials.map((material,index)=>{
    const row=entries.find(item=>item.materialId===material.materialId),saved=verification.entries.find(item=>item.materialId===material.materialId),name=material.name||material.label||'未命名材料';
    return <section className="material-verification-card" key={material.materialId} aria-label={`${name}核对`}><header><h4>{index+1}. {name}</h4><span>{material.category}{material.auxiliaryKind?` · ${material.auxiliaryKind}`:''}</span></header>
     <dl className="material-verification-specs"><div><dt>规格</dt><dd>{material.specification||'未登记'}</dd></div><div><dt>数量</dt><dd>{material.quantity||'未登记'}</dd></div><div><dt>颜色</dt><dd>{material.color||'未登记'}</dd></div>{material.label&&material.label!==material.name&&<div><dt>材料标记</dt><dd>{material.label}</dd></div>}</dl>
     {!row?<p>未填写实际材料，仅为空白占位；不代表已确认不使用</p>:<>
      <label className="material-usage-label">本轮使用情况<select aria-label={`${name}使用情况`} value={row.usage} onChange={e=>change(row.materialId,{usage:e.target.value as MaterialVerificationEntry['usage']})}><option value="pending">待文员确认</option><option value="use">本轮使用</option><option value="unused">本轮不使用</option></select></label>
      {row.usage==='unused'&&<div className="material-unused-reason"><label>已向哪位设计师确认<input value={row.confirmedWith} maxLength={100} onChange={e=>change(row.materialId,{confirmedWith:e.target.value})}/></label><label>不使用确认说明<input value={row.note} maxLength={1000} onChange={e=>change(row.materialId,{note:e.target.value})}/></label></div>}
      <div className="material-verification-checks">{MATERIAL_CHECK_FIELDS.map(field=>{const rule=materialCellEligibility(row,field,verification.bulkRules,returnIssues);return <div key={field}><label><input type="checkbox" aria-label={`${name} ${MATERIAL_CHECK_LABELS[field]}`} checked={row[field]} disabled={locked||row.usage!=='use'||(rule.knownConflict&&!row[field])} onChange={e=>change(row.materialId,{[field]:e.target.checked})}/>{MATERIAL_CHECK_LABELS[field]}</label>{!rule.canSelect&&<small>{rule.reason}</small>}</div>;})}</div>
      {saved?.invalidated.map(text=><p className="material-check-warning" key={text}>{text}</p>)}
      {saved?.changedAt&&<details><summary>输入保存记录</summary><p>上次保存：{new Date(saved.changedAt).toLocaleString('zh-CN')} · 确认人 {saved.changedBy}。此记录不代表已提交核料。</p></details>}
     </>}
    </section>;
   })}</div>
   {returning&&<section className="material-return-panel"><h4>指出具体问题，交给设计师处理</h4><DevelopmentReturnIssues document={state!.sheet.document!} value={returnIssues} onChange={setReturnIssues} disabled={locked}/><Button type="button" onClick={()=>setReturning(false)}>返回正常提交</Button></section>}
   {!returning&&returnIssues.length>0&&<p role="status">本页仍保留 {returnIssues.length} 项问题。提交通过前请打开退回问题逐项核实；不会自动清除。</p>}
   <label>缺项 / 备注<textarea aria-label="缺项 / 备注" value={note} onChange={e=>setNote(e.target.value)} maxLength={1000}/></label>
   <Button type="button" disabled={locked} onClick={()=>void save()}>保存核料输入</Button>
   <WorkbenchAction type="submit" variant="primary" disabled={locked}>{returning?'确认退回补正 / 补料':'核对完成并提交'}</WorkbenchAction>
   {!returning&&<WorkbenchAction type="button" disabled={locked} onClick={()=>setReturning(true)}>退回补正 / 补料</WorkbenchAction>}
  </fieldset>
  {phase==='saving'&&<p role="status">正在保存核料输入…</p>}
  {(phase==='saved'||(phase==='idle'&&controller.writeOutcome?.path==='material-verification'&&controller.writeOutcome.phase==='complete'))&&<p role="status">输入已保存为草稿；提交后才成为本轮核料记录。</p>}
  {phase==='checking'&&<p role="status">输入已保存，正在提交核料结果…</p>}
  {phase==='check-incomplete'&&!controller.uncertainWrite&&<p role="status">输入已保存，本次核料尚未取得完成回执，请查看具体原因后继续。</p>}
  {controller.uncertainWrite&&<p role="status">{controller.writeOutcome?.phase==='committed'&&controller.writeOutcome.path==='material-verification'?'保存已确认，最新资料尚未读回；请重新读取，勿重复保存。':'提交结果尚未确认，请核对并重试原操作；不会把未知结果当作失败重做。'}</p>}
 </form>;
}
