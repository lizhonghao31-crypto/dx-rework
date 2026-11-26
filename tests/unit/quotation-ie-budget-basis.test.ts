import {randomUUID} from 'node:crypto';
import {describe,expect,it} from 'vitest';
import {confirmedIeBudgetBasis,type ConfirmedIeQuote} from '../../apps/api/src/production-platform/quotation-ie-budget-basis.js';

function quote():ConfirmedIeQuote {
 const rowId=randomUUID(),ie=randomUUID();
 return {
  quote_id:randomUUID(),version:8,
  assembly:{schemaVersion:1,sourceVersion:3,roundNumber:2,fingerprint:'original confirmed assembly',
   rows:{[rowId]:{kind:'ie',sourceRef:'ie:processing',basis:'original approved processing',stage:'development'}}},
  document:{fabricType:'',productCategory:'上衣',monthSeries:'',date:null,currency:'人民币',freight:'',cm:'',salePrice:'32.4',
   outsourcingScope:'成衣加工',outsourcingUnitPrice:'',imageAttachmentIds:[],
   rows:[{rowId,section:'外发工序',category:'IE加工',name:'IE加工单价',specification:'',unit:'件',supplier:'',consumption:'1',unitPrice:'15.8000'}]},
  assignments:[{rowId,technicalAssigneeId:null,priceAssigneeId:ie,priceRole:'ie_reviewer'}],
  price_sources:{[rowId]:{actorId:ie,role:'ie_reviewer',version:7,recordedAt:'2026-11-26T05:00:00.000Z'}},
 };
}

describe('confirmed IE basis for the original outsourced budget',()=>{
 it('uses the precise IE field and quote version independently of the customer price',()=>{
  const original=quote();
  const rowId=original.document.rows[0]!.rowId;
  expect(confirmedIeBudgetBasis(original)).toEqual({quoteId:original.quote_id,quoteVersion:8,rowId,priceVersion:7,
   sourceVersion:3,roundNumber:2,actorId:original.price_sources[rowId]!.actorId,recordedAt:'2026-11-26T05:00:00.000Z',
   unitPrice:'15.8',unit:'件',currency:'人民币'});
 });
 it.each(['', '0.000', '15.801', '1e2'])('declines missing, zero, or unsupported IE price %s',value=>{
  const original=quote();
  original.document.rows[0]!.unitPrice=value;
  expect(confirmedIeBudgetBasis(original)).toBeNull();
 });
 it('declines duplicate IE inputs, the wrong unit, and a mismatched original price author',()=>{
  const original=quote(),unit=quote(),author=quote();
  const id=original.document.rows[0]!.rowId;
  original.assembly!.rows[randomUUID()]=original.assembly!.rows[id]!;
  unit.document.rows[0]!.unit='米';
  author.price_sources[author.document.rows[0]!.rowId]!.actorId=randomUUID();
  for(const invalid of [original,unit,author])expect(confirmedIeBudgetBasis(invalid)).toBeNull();
 });
});
