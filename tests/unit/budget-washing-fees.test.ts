import {it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {BudgetWashingFeeSchema} from '../../packages/contracts/src/digital-budget.js';
import {readDigitalDetailContext,documentChapterIds} from '../../apps/web/src/digital-detail-context.js';
import {budgetWashingFeeResult} from '../../apps/web/src/budget-washing-fee-result.js';
const input={expectedVersion:2,lineId:randomUUID(),expectedWashingVersion:1,reason:'TEST 单独补录洗水费用',source:{kind:'new',row:{name:'大货洗水',specification:'',unit:'件',supplier:'TEST',consumption:'1',unitPrice:'0'}}};
it('distinguishes an explicit zero price from missing inputs and cannot submit another budget document',()=>{
 expect(BudgetWashingFeeSchema.parse(input).source).toMatchObject({kind:'new',row:{unitPrice:'0'}});
 for(const patch of [{unitPrice:''},{consumption:''},{unit:''},{unitPrice:'-1'},{unitPrice:'1e2'}])expect(BudgetWashingFeeSchema.safeParse({...input,source:{...input.source,row:{...input.source.row,...patch}}}).success).toBe(false);
 expect(BudgetWashingFeeSchema.safeParse({...input,document:{cm:'0'}}).success).toBe(false);
 expect(BudgetWashingFeeSchema.safeParse({...input,source:{kind:'existing',version:2,rowId:randomUUID()}}).success).toBe(true);
});
it('keeps the original budget chapter route readable without adding another business page',()=>{
 expect(documentChapterIds).toContain('budget-washing-fees');
 expect(readDigitalDetailContext('?budget='+randomUUID()+'&documentChapter=budget-washing-fees').chapter).toBe('budget-washing-fees');
 expect(readDigitalDetailContext('?documentChapter=budget-washing-fees&documentChapter=budget-summary').chapter).toBeUndefined();
});
it('certifies the original order, PO, applied versions and exact financial row rather than any successful JSON',()=>{
 const body=BudgetWashingFeeSchema.parse(input),id=randomUUID(),rowId=randomUUID();
 const result={productionOrderId:id,budgetVersion:3,canPublish:true,reason:'',comparison:null,references:[],history:[],lines:[{lineId:body.lineId,label:'TEST',version:2,fee:{kind:'budget_row',version:3,rowId}}],rows:[{...input.source.row,rowId,section:'外发工序',category:'洗水'}]};
 expect(budgetWashingFeeResult(result,id,body)).toBe(true);
 for(const wrong of [{...result,productionOrderId:randomUUID()},{...result,budgetVersion:2},{...result,references:undefined},{...result,lines:[]},{...result,rows:[{...result.rows[0],unitPrice:'2'}]},{}])expect(budgetWashingFeeResult(wrong,id,body)).toBe(false);
 expect(budgetWashingFeeResult({...result,lines:[{...result.lines[0],fee:{kind:'pending'}}]},id,body)).toBe(false);
});
