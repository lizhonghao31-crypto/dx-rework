import {expect,it} from 'vitest';
import type {OrderTimeCheckResult,OrderTimeWashingChanges} from '@dx-rework/contracts/order-time-requests';
import {rebaseWashingChanges} from '../../apps/web/src/order-time-washing-rebase.js';

const lineId='11111111-1111-4111-8111-111111111111',staff='22222222-2222-4222-8222-222222222222',nextStaff='33333333-3333-4333-8333-333333333333';
const rule={minutes:120,calendar:'continuous' as const,reminder:{enabled:true,percent:70}};
const arrangement={mode:'after_receipt' as const,accounting:'additional' as const,reference:'TEST scope',revision:1,washing:rule,inspection:{...rule,minutes:60}};
const rows:NonNullable<OrderTimeCheckResult['washing']>=[{lineId,label:'TEST PO',version:1,document:{arrangement,staff:{logisticsId:staff,inspectorId:staff},fee:{kind:'pending'},sourceRef:'TEST original'}}];
const proposal=():OrderTimeWashingChanges=>[{lineId,expectedVersion:1,document:{...structuredClone(rows[0]!.document!),arrangement:{...structuredClone(arrangement),revision:2,washing:{...rule,minutes:240}}}}];
it('rebinds explicit edits to the fresh version while preserving independently changed staff and fee provenance',()=>{
 const fresh=structuredClone(rows);fresh[0]!.version=2;fresh[0]!.document!.staff!.logisticsId=nextStaff;
 fresh[0]!.document!.fee={kind:'budget_row',version:3,rowId:'44444444-4444-4444-8444-444444444444'};
 const before=structuredClone({rows,changes:proposal(),fresh});
 const rebased=rebaseWashingChanges(rows,before.changes,fresh);
 expect(rebased[0]).toMatchObject({expectedVersion:2,document:{arrangement:{revision:3,washing:{minutes:240}},staff:{logisticsId:nextStaff},fee:{kind:'budget_row',version:3,rowId:'44444444-4444-4444-8444-444444444444'}}});
 expect({rows,changes:proposal(),fresh}).toEqual(before);
});
it('retains deliberately edited staff and rejects a disappeared PO rather than inventing a new scope',()=>{
 const changes=proposal();changes[0]!.document.staff!.logisticsId=nextStaff;
 expect(rebaseWashingChanges(rows,changes,rows)[0]!.document.staff!.logisticsId).toBe(nextStaff);
 expect(()=>rebaseWashingChanges(rows,changes,[])).toThrow('PO范围已变化');
});
