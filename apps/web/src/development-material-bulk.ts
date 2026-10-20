import {type MaterialBulkRules,type MaterialCheckField,type MaterialVerificationEntry} from '@dx-rework/contracts/digital-development-execution';
import type {DevelopmentReturnIssue} from '@dx-rework/contracts/digital-development-amendments';
export function materialCellEligibility(row:MaterialVerificationEntry,field:MaterialCheckField,rules:MaterialBulkRules|undefined,issues:DevelopmentReturnIssue[]){
 if(row.usage!=='use')return {canSelect:false,knownConflict:false,reason:row.usage==='pending'?'待文员确认本轮使用':'本轮不使用'};
 const local=issues.find(issue=>issue.materialId===row.materialId&&issue.field===field);
 if(local)return {canSelect:false,knownConflict:true,reason:`本页已记录问题：${local.reason}；全选不会覆盖`};
 return rules?.find(rule=>rule.materialId===row.materialId)?.checks[field]??{canSelect:false,knownConflict:false,reason:'批量核对依据未就绪，请重新读取；仍可逐项核实'};
}
export function selectMaterialField(entries:MaterialVerificationEntry[],field:MaterialCheckField,rules:MaterialBulkRules|undefined,issues:DevelopmentReturnIssue[]){
 const selected:string[]=[];
 const next=entries.map(row=>{
  if(row[field]||!materialCellEligibility(row,field,rules,issues).canSelect)return row;
  selected.push(row.materialId);return {...row,[field]:true};
 });
 return {entries:next,selected};
}
export function materialBulkCounts(entries:MaterialVerificationEntry[],field:MaterialCheckField,rules:MaterialBulkRules|undefined,issues:DevelopmentReturnIssue[]){
 const checked=entries.filter(row=>row.usage==='use'&&row[field]).length;
 const selectable=entries.filter(row=>!row[field]&&materialCellEligibility(row,field,rules,issues).canSelect).length;
 return {checked,selectable,excluded:entries.length-checked-selectable};
}
export const cleanMaterialEntries=(entries:MaterialVerificationEntry[])=>entries.map(({materialId,usage,note,confirmedWith,physical,quantity,color,specification})=>({materialId,usage,note,confirmedWith,physical,quantity,color,specification}));
