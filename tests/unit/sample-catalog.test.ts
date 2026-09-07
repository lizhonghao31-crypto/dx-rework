import { describe, it, expect } from 'vitest';
import type { SampleView } from '@dx-rework/contracts';
import { sampleDisplayMoney, sampleBatchSelection } from '../../apps/web/src/sample-catalog-model.js';
const items = [
  {sampleId:'one',status:'borrowed',holderUserId:'owner',version:3},
  {sampleId:'two',status:'borrowed',holderUserId:'other',version:4},
  {sampleId:'three',status:'return_pending',holderUserId:'owner',version:5},
] as SampleView[];
describe('sample catalog selection boundary',()=>{
  it('limits ordinary users to their own current-page borrowed selections',()=>{
    expect(sampleBatchSelection(items,['one','two','three','off-page'],{id:'owner',isRoot:false})).toEqual([items[0]]);
    expect(sampleBatchSelection(items,['one'],null)).toEqual([]);
  });
  it('allows Root delegation but never includes pending or off-page records',()=>{
    expect(sampleBatchSelection(items,['one','two','three','off-page'],{id:'root',isRoot:true})).toEqual([items[0],items[1]]);
    expect(sampleBatchSelection(items,[],{id:'root',isRoot:true})).toEqual([]);
  });
  it('preserves decimal text while grouping large purchase prices',()=>{
    expect(sampleDisplayMoney('999999999999.99')).toBe('999,999,999,999.99');
    expect(sampleDisplayMoney('12999.80')).toBe('12,999.8');
    expect(sampleDisplayMoney('0.00')).toBe('0');
    expect(sampleDisplayMoney('0.01')).toBe('0.01');
  });
});
