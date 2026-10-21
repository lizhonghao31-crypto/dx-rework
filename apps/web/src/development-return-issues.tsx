import type {DevelopmentDocument} from "@dx-rework/contracts/digital-development";
import {MATERIAL_RETURN_FIELDS,DOCUMENT_RETURN_FIELDS,DEVELOPMENT_RETURN_FIELD_LABELS,developmentReturnNeed,type DevelopmentReturnIssue} from "@dx-rework/contracts/digital-development-amendments";
import {Button} from "@dx-rework/ui";
export const RETURN_FIELD_LABELS=DEVELOPMENT_RETURN_FIELD_LABELS;
export function DevelopmentReturnIssues({document,value,onChange,disabled=false}:{document:DevelopmentDocument;value:DevelopmentReturnIssue[];onChange:(value:DevelopmentReturnIssue[])=>void;disabled?:boolean}){
 const change=(index:number,patch:Partial<DevelopmentReturnIssue>)=>onChange(value.map((issue,i)=>i===index?{...issue,...patch}:issue));
 return <section aria-label="退回问题位置"><p>请指出具体问题。与已勾选“相符”的同一项矛盾时须先核实；其他资料错误可以单独退回。</p>{value.map((issue,index)=><div key={index}>
  <label>问题材料 / 区域<select aria-label={`问题${index+1}材料或区域`} disabled={disabled} value={issue.materialId??""} onChange={event=>change(index,{materialId:event.target.value||null,field:"other",need:"document"})}><option value="">本单其他资料</option>{document.materials.map(m=><option key={m.materialId} value={m.materialId}>{m.name||m.label||m.category}</option>)}</select></label>
  <label>问题字段<select aria-label={`问题${index+1}字段`} disabled={disabled} value={issue.field} onChange={event=>change(index,{field:event.target.value as DevelopmentReturnIssue["field"],...(event.target.value==="physical"?{need:"supply"}:{})})}>{(issue.materialId?MATERIAL_RETURN_FIELDS:DOCUMENT_RETURN_FIELDS).map(field=><option key={field} value={field}>{RETURN_FIELD_LABELS[field]}</option>)}</select></label>
  <label>需要处理什么<select aria-label={`问题${index+1}处理方式`} disabled={disabled||issue.field==="physical"||!issue.materialId} value={developmentReturnNeed(issue)} onChange={event=>change(index,{need:event.target.value as "document"|"supply"})}><option value="document">资料需要修改 / 澄清</option><option value="supply">实物需要补齐 / 更换</option></select></label>
  <label>具体问题<input aria-label={`问题${index+1}原因`} disabled={disabled} value={issue.reason} maxLength={1000} onChange={event=>change(index,{reason:event.target.value})}/></label><Button disabled={disabled} type="button" onClick={()=>onChange(value.filter((_,i)=>i!==index))}>移除此问题</Button>
 </div>)}<Button disabled={disabled||value.length>=100} type="button" onClick={()=>onChange([...value,{materialId:null,field:"other",reason:""}])}>添加退回问题</Button></section>;
}
