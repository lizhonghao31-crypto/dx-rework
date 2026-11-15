import {BudgetRowSchema,type BudgetWashingFeeInput,type BudgetWashingFees} from '@dx-rework/contracts/digital-budget';
/** A readable page or successful HTTP status is not an applied fee receipt. */
export function budgetWashingFeeResult(value:unknown,orderId:string,input:BudgetWashingFeeInput):value is BudgetWashingFees{
 if(!value||typeof value!=='object')return false;
 const data=value as BudgetWashingFees,expected=input.expectedVersion+(input.source.kind==='existing'?0:1);
 if(data.productionOrderId!==orderId||data.budgetVersion!==expected||typeof data.canPublish!=='boolean'||!Array.isArray(data.lines)||!Array.isArray(data.rows)||!Array.isArray(data.history)||!Array.isArray(data.references))return false;
 const lines=data.lines.filter(line=>line?.lineId===input.lineId),line=lines[0];
 if(lines.length!==1||line?.version!==input.expectedWashingVersion+1||line.fee?.kind!=='budget_row')return false;
 const fee=line.fee,source=input.source;
 if(fee.version!==(source.kind==='existing'?source.version:expected)||(source.kind!=='new'&&fee.rowId!==source.rowId))return false;
 const rows=data.rows.filter(row=>row?.rowId===fee.rowId),row=rows[0];
 if(rows.length!==1||!BudgetRowSchema.safeParse(row).success||row?.section!=='外发工序')return false;
 return source.kind==='existing'||Object.entries(source.row).every(([key,value])=>row[key as keyof typeof row]===value);
}
