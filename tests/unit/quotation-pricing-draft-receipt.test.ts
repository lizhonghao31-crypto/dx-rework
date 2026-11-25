import {describe,expect,it} from 'vitest';
import {confirmsQuotationPricingDraft} from '../../apps/web/src/quotation-pricing-draft-receipt.js';

const expected={resource:{kind:'source' as const,id:'20fda092-7502-4612-8af4-251bc206a13c'},
 quoteId:'7cd3f988-a895-4cbb-8a3a-bf9d0fbac507',version:7};
const same={...expected,commandReceipt:{action:'workbench-pricing-draft',appliedVersion:7}};

describe('explicit commercial calculation receipt',()=>{
 it('recognizes a persisted calculation without advancing the quote version or claiming confirmation',()=>{
  expect(confirmsQuotationPricingDraft(same,expected)).toBe(true);
  expect(confirmsQuotationPricingDraft({...same,version:8},expected)).toBe(true);
 });
 it('does not accept a confirmation, a different order or quote, or a different applied version as a save',()=>{
  for(const other of [{...same,commandReceipt:{action:'confirm',appliedVersion:7}},
   {...same,resource:{...same.resource,kind:'order'}},{...same,quoteId:same.resource.id},
   {...same,commandReceipt:{action:'workbench-pricing-draft',appliedVersion:8}},
   {...same,version:6},{...same,commandReceipt:undefined}])expect(confirmsQuotationPricingDraft(other,expected)).toBe(false);
 });
});
