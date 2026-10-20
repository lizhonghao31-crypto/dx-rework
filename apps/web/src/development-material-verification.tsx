import {DevelopmentReturnIssues} from "./development-return-issues.js";
import type {DevelopmentReturnIssue} from "@dx-rework/contracts/digital-development-amendments";
import "./development-material-verification.css";
import {useEffect,useState} from "react";
import {Button} from "@dx-rework/ui";
import type {DigitalTask} from "@dx-rework/contracts/digital-production-tasks";
import type {MaterialVerificationEntry} from "@dx-rework/contracts/digital-development-execution";
import type {useDevelopmentExecution} from "./digital-development-execution-panel.js";
import {useDigitalDetailNavigationGuard} from "./use-digital-detail-navigation-guard.js";
import {WorkbenchAction} from "./workbench-action.js";
export function DevelopmentMaterialVerification({controller,task}:{controller:ReturnType<typeof useDevelopmentExecution>;task:DigitalTask}){
 const {state,busy,run}=controller,verification=state!.materialVerification!;
 const [returnIssues,setReturnIssues]=useState<DevelopmentReturnIssue[]>(verification.returnIssues??[]);
 const [entries,setEntries]=useState<MaterialVerificationEntry[]>(verification.entries),[note,setNote]=useState(verification.note),[result,setResult]=useState<string>(verification.result);
 useEffect(()=>{setReturnIssues(verification.returnIssues??[]);setEntries(verification.entries);setNote(verification.note);setResult(verification.result);},[verification.version,verification.documentVersion,task.taskId]);
 const clean=(rows:MaterialVerificationEntry[])=>rows.map(({materialId,usage,physical,quantity,color,specification,note,confirmedWith})=>({materialId,usage,physical,quantity,color,specification,note,confirmedWith}));
 const dirty=JSON.stringify([clean(entries),note,result,returnIssues])!==JSON.stringify([clean(verification.entries),verification.note,verification.result,verification.returnIssues??[]]);
 useDigitalDetailNavigationGuard(dirty&&!controller.uncertainWrite&&!controller.checkReceipt,busy,controller.writing,"核料输入尚未保存，确定离开？");
 const change=(id:string,patch:Partial<MaterialVerificationEntry>)=>setEntries(rows=>rows.map(row=>row.materialId===id?{...row,...patch}:row));
 const save=()=>run("material-verification",{returnIssues:result==="缺项退回"?returnIssues:[],note,result,taskId:task.taskId,expectedDocumentVersion:verification.documentVersion,expectedVersion:verification.version,entries:entries.map(({materialId,usage,physical,quantity,color,specification,note,confirmedWith})=>({materialId,usage,physical,quantity,color,specification,note,confirmedWith}))});
 const submit=async()=>{const saved=await save();if(!saved?.materialVerification)return;await run("check",{returnIssues:result==="缺项退回"?returnIssues:[],taskId:task.taskId,expectedVerificationVersion:saved.materialVerification.version,result,note,items:saved.materialVerification.entries.filter(row=>row.usage==="use").map(({materialId,physical,quantity,color,specification})=>({materialId,physical,quantity,color,specification}))});};
 if(controller.checkReceipt)return <p role="status">核料已完成。{controller.navigationFailed?"委派页暂未打开，请重新打开；无需再次提交核料。":"正在打开本轮委派页…"}<a href={controller.checkReceipt.target}>打开本轮委派页</a></p>;
 return <form className="development-material-check-form development-material-verification" onSubmit={e=>{e.preventDefault();void submit();}}>
  <p>请由文员逐项确认本轮是否使用。不使用的材料须先与设计师确认；保存保留输入，提交才完成本次核料。</p>
  <p>表格可横向滚动查看四项核验。</p>
  <fieldset disabled={busy}><div className="development-table-scroll"><table><thead><tr><th>材料 / 规格 / 数量</th><th>本轮使用情况</th>{["实物已到","数量相符","颜色相符","规格相符"].map(label=><th key={label}>{label}</th>)}</tr></thead>
   <tbody>{state!.sheet.document!.materials.map(m=>{const row=entries.find(r=>r.materialId===m.materialId),saved=verification.entries.find(r=>r.materialId===m.materialId);return <tr key={m.materialId}><th>{m.name||m.label}<small>{m.category} · {m.label!==m.name?m.label:""} · {m.specification||"规格未登记"} · {m.quantity||"数量未登记"}</small></th>{!row?<td colSpan={5}>未填写实际材料，仅为空白占位；不代表已确认不使用</td>:<>
    <td><label>{m.name||m.label}使用情况<select aria-label={`${m.name||m.label}使用情况`} value={row.usage} onChange={e=>change(m.materialId,{usage:e.target.value as MaterialVerificationEntry["usage"]})}><option value="pending">待文员确认</option><option value="use">本轮使用</option><option value="unused">本轮不使用</option></select></label>
    {row.usage==="unused"&&<><label>已向哪位设计师确认<input value={row.confirmedWith} maxLength={100} onChange={e=>change(m.materialId,{confirmedWith:e.target.value})}/></label><label>不使用确认说明<input value={row.note} maxLength={1000} onChange={e=>change(m.materialId,{note:e.target.value})}/></label></>}
    {saved?.invalidated.map(text=><p key={text}>{text}</p>)}{saved?.changedAt&&<small>上次保存：{new Date(saved.changedAt).toLocaleString("zh-CN")} · 确认人 {saved.changedBy}</small>}</td>
    {(["physical","quantity","color","specification"] as const).map((key,index)=><td key={key}>{row.usage==="use"?<input type="checkbox" aria-label={`${m.name||m.label} ${["实物已到","数量相符","颜色相符","规格相符"][index]}`} checked={row[key]} onChange={e=>change(m.materialId,{[key]:e.target.checked})}/>:row.usage==="pending"?"待确认":"本轮不使用"}</td>)}</>}</tr>;})}</tbody></table></div>
   <Button type="button" onClick={()=>void save()}>保存核料输入</Button>
   <label>核对结果<select value={result} onChange={e=>setResult(e.target.value)}><option>通过</option><option>缺项退回</option></select></label>
   {result==="缺项退回"&&<DevelopmentReturnIssues document={state!.sheet.document!} value={returnIssues} onChange={setReturnIssues} disabled={busy}/>}
   <label>缺项 / 备注<textarea aria-label="缺项 / 备注" value={note} onChange={e=>setNote(e.target.value)} maxLength={1000}/></label>
   <WorkbenchAction type="submit" variant="primary">保存并提交核料结果</WorkbenchAction>
  </fieldset>
 </form>;
}
