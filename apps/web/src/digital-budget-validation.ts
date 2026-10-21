import { BUDGET_SECTIONS, BudgetDocumentSchema, budgetPublishErrors, type BudgetDocument } from "@dx-rework/contracts/digital-budget";
import type { DocumentIssue } from "./document-editor.js";
export const budgetColumns = { category: "类型", name: "物料或工序", specification: "规格", unit: "单位", supplier: "供应方", consumption: "单件用量", unitPrice: "单价不含税" } as const;
export const budgetFieldLabels: Record<string,string> = {fabricType:"面料属性",productCategory:"产品类别",monthSeries:"月份系列",date:"预算日期",freight:"运费",cm:"CM加工费用（裁、车、烫、包装）",salePrice:"销售单价（不含税，人民币）",outsourcingScope:"本次实际外发范围",outsourcingUnitPrice:"本次实际外发预算价",imageAttachmentIds:"款图",rows:"预算明细"};
/** Resolve stable row IDs against the current draft, including reordered/deleted rows. */
export function budgetFieldChapter(id:string,document:BudgetDocument):string|undefined{
 if(['productCategory','fabricType','monthSeries','imageAttachmentIds','rows'].some(key=>id===`budget-${key}`))return 'budget-basic';
 if(['freight','cm','salePrice','currency'].some(key=>id===`budget-${key}`))return 'budget-summary';
 if(['date','outsourcingScope','outsourcingUnitPrice'].some(key=>id===`budget-${key}`))return 'budget-outsourcing';
 const row=document.rows.find(row=>Object.keys(budgetColumns).some(key=>id===`budget-${row.rowId}-${key}`));
 return row?`budget-section-${BUDGET_SECTIONS.indexOf(row.section)}`:undefined;
}
export function budgetIssues(document:BudgetDocument,publish=false):DocumentIssue[]{
 const parsed=BudgetDocumentSchema.safeParse(document);
 if(!parsed.success)return parsed.error.issues.map(issue=>{const row=issue.path[0]==="rows"&&typeof issue.path[1]==="number"?document.rows[issue.path[1]]:null;const key=String(row?issue.path[2]:issue.path[0]);return {id:row?`budget-${row.rowId}-${key}`:`budget-${key}`,label:row?`${row.section} · ${row.name||row.category||"未命名行"} · ${budgetColumns[key as keyof typeof budgetColumns]??key}`:budgetFieldLabels[key]??key,message:issue.message};});
 if(!publish)return [];
 const errors=budgetPublishErrors(parsed.data),fields=["productCategory","fabricType","date","outsourcingScope","outsourcingUnitPrice"];
 const issues:DocumentIssue[]=[];
 for(const message of errors){
  if(message.startsWith("有内容的预算行"))continue;
  const key=message.includes("外发预算价")?"outsourcingUnitPrice":fields.find(field=>message.includes(budgetFieldLabels[field]!))??"outsourcingScope";
  issues.push({id:`budget-${key}`,label:budgetFieldLabels[key]!,message});
 }
 for(const row of document.rows){if([row.name,row.specification,row.consumption,row.unitPrice].some(Boolean)&&(!row.name||row.consumption===""||row.unitPrice==="")){const key=!row.name?"name":row.consumption===""?"consumption":"unitPrice";issues.push({id:`budget-${row.rowId}-${key}`,label:`${row.section} · ${row.name||row.category||"未命名行"} · ${budgetColumns[key]}`,message:"有内容的预算行须填写物料或工序、单件用量和单价"});}}
 return issues;
}
