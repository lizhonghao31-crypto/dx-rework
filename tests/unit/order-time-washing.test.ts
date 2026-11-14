import {expect,it,vi} from 'vitest';
import type {PoolClient} from 'pg';
import {orderTimeWashingState} from '../../apps/api/src/production-platform/order-time-washing.js';
import {OrderTimeWashingChangesSchema} from '@dx-rework/contracts/order-time-requests';

const red='11111111-1111-4111-8111-111111111111',blue='22222222-2222-4222-8222-222222222222';
const document={arrangement:{mode:'none' as const},fee:{kind:'pending' as const},sourceRef:'TEST original arrangement'};
function fixture(){
 const query=vi.fn(async(sql:string)=>{
  if(sql.startsWith('SELECT line_id'))return {rows:[{line_id:red},{line_id:blue}]};
  if(sql.startsWith('SELECT * FROM digital_bulk_washing_plans'))return {rows:[
   {plan_id:'old',production_order_id:'order',line_id:red,version:1,document},
   {plan_id:'current',production_order_id:'order',line_id:red,version:2,document},
  ]};
  throw Error('Unexpected write or read: '+sql);
 });
 return {db:{query} as unknown as Pick<PoolClient,'query'>,query};
}
it('previews only the selected PO, retains current versions and makes no writes',async()=>{
 const {db,query}=fixture();
 const proposed={...document,sourceRef:'TEST proposed'};
 const result=await orderTimeWashingState(db,'order',[{lineId:red,expectedVersion:2,document:proposed}]);
 expect(result.get(red)).toEqual({label:red,version:2,document:proposed});
 expect(result.get(blue)).toEqual({label:blue,version:0,document:null});
 proposed.sourceRef='changed after preview';
 expect(result.get(red)?.document?.sourceRef).toBe('TEST proposed');
 expect(document.sourceRef).toBe('TEST original arrangement');
 expect(query).toHaveBeenCalledTimes(2);
});
it('rejects stale, unrelated and duplicate PO changes before adoption',async()=>{
 for(const changes of [
  [{lineId:red,expectedVersion:1,document}],
  [{lineId:'33333333-3333-4333-8333-333333333333',expectedVersion:0,document}],
  [{lineId:red,expectedVersion:2,document},{lineId:red,expectedVersion:2,document}],
 ])await expect(orderTimeWashingState(fixture().db,'order',changes)).rejects.toThrow();
 expect(OrderTimeWashingChangesSchema.safeParse([{lineId:red,expectedVersion:2,document},{lineId:red,expectedVersion:2,document}]).success).toBe(false);
});
