import {expect,it} from 'vitest';
import type {JourneyNode,OrderJourney} from '@dx-rework/contracts/digital-production-journey';
import type {OrderClosureSheet} from '@dx-rework/contracts/order-closure';
import {attachJourneyNativeTimes} from '../../apps/api/src/production-platform/journey-native-times.js';
import {journeyActualPoint} from '../../apps/api/src/production-platform/journey-progress-dates.js';

const start='2026-11-04T00:00:00.000Z',end='2026-11-04T06:00:00.000Z',asOf='2026-11-05T00:00:00.000Z';
const fixture=()=>{
 const node={key:'rework',instanceId:'TEST-rework',round:null,occurrence:null,current:true,state:'completed',enteredAt:null,actualAt:null,actualQuality:'missing',completionResult:'unknown',records:[{domain:'rework',id:'TEST-rework',lineId:'TEST-line',url:null,version:null,mode:'read'}]} as JourneyNode;
 const item={orderId:'TEST-order',stages:[{nodes:[node]}]} as OrderJourney;
 const window={windowKey:'TEST-window',lineId:'TEST-line',reworkId:'TEST-rework',startedAt:start,completedAt:end,complete:true,deadline:null,warningAt:null,evidence:'rework:TEST-rework:effective-worker-reports',snapshotId:null};
 return {node,item,native:{orderId:'TEST-order',rework:[window],receiving:undefined}};
};
it('Final10 exact rework and PO use complete effective worker times in the original actual-date consumer',()=>{
 const {node,item,native}=fixture();attachJourneyNativeTimes(item,native,asOf);
 expect(node).toMatchObject({state:'completed',enteredAt:start,actualAt:end,actualQuality:'unverified'});
 expect(journeyActualPoint(node,asOf)).toEqual({at:end,precision:'instant',quality:'recorded'});
 attachJourneyNativeTimes(item,{...native,rework:[{...native.rework[0]!,complete:false,completedAt:null}]},asOf);
 expect(node).toMatchObject({state:'completed',actualAt:null,actualQuality:'missing'});
 native.rework=[];attachJourneyNativeTimes(item,native,asOf);expect(node).toMatchObject({enteredAt:null,actualAt:null});
});
it.each(['order','rework','line','retired'])('Final10 never copies a completion from mismatched %s scope',kind=>{
 const {node,item,native}=fixture();
 if(kind==='order')native.orderId='TEST-other';if(kind==='rework')native.rework[0]!.reworkId='TEST-other';if(kind==='line')native.rework[0]!.lineId='TEST-other';if(kind==='retired')node.current=false;
 attachJourneyNativeTimes(item,native,asOf);expect(node.actualAt).toBeNull();expect(node.enteredAt).toBeNull();
});
it('Final10 does not close an active rework or rate a future worker completion',()=>{
 const first=fixture();first.node.state='active';attachJourneyNativeTimes(first.item,first.native,asOf);expect(first.node).toMatchObject({state:'active',actualAt:null,enteredAt:start});
 const second=fixture();second.native.rework[0]!.completedAt='2026-11-06T00:00:00Z';attachJourneyNativeTimes(second.item,second.native,asOf);expect(second.node.actualAt).toBeNull();
});
it('Final10 receiving uses its first effective instant and never assigns midnight to a date-only arrival',()=>{
 const {node,item,native}=fixture();node.key='receipts';node.instanceId='receipts:0';node.state='active';
 const receiving:NonNullable<OrderClosureSheet['receivingSpan']>={firstEffectiveReceipt:{id:'TEST-receipt',receivedAt:start,receivedDate:null,precision:'instant'},history:[],collectedAt:null,elapsedHours:null,reason:null};
 attachJourneyNativeTimes(item,{...native,receiving},asOf);expect(node.enteredAt).toBe(start);
 receiving.firstEffectiveReceipt={id:'TEST-receipt',receivedAt:null,receivedDate:'2026-11-04',precision:'date'};
 attachJourneyNativeTimes(item,{...native,receiving},asOf);expect(node.enteredAt).toBeNull();
});
