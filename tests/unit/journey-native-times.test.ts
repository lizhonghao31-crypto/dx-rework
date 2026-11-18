import {expect,it} from 'vitest';
import type {JourneyNode,OrderJourney} from '@dx-rework/contracts/digital-production-journey';
import type {OrderClosureSheet} from '@dx-rework/contracts/order-closure';
import {attachJourneyNativeTimes,journeyCuttingGateTime} from '../../apps/api/src/production-platform/journey-native-times.js';
import type {NativeCuttingReadiness} from '../../apps/api/src/production-platform/task-readiness-facts.js';
import {journeyActualPoint} from '../../apps/api/src/production-platform/journey-progress-dates.js';
import {cockpitResponsibilityResult} from '../../apps/web/src/cockpit-node-summary.js';

const start='2026-11-04T00:00:00.000Z',end='2026-11-04T06:00:00.000Z',asOf='2026-11-05T00:00:00.000Z';
const fixture=()=>{
 const node={key:'rework',instanceId:'TEST-rework',round:null,occurrence:null,current:true,state:'completed',enteredAt:null,actualAt:null,actualQuality:'missing',completionResult:'unknown',records:[{domain:'rework',id:'TEST-rework',lineId:'TEST-line',url:null,version:null,mode:'read'}]} as JourneyNode;
 const item={orderId:'TEST-order',stages:[{nodes:[node]}]} as OrderJourney;
 const window={windowKey:'rework:TEST-rework:TEST-assignment',assignmentId:'TEST-assignment',lineId:'TEST-line',reworkId:'TEST-rework',startedAt:start,completedAt:end,complete:true,deadline:null,warningAt:null,evidence:'rework:TEST-rework:assignment:TEST-assignment:effective-worker-reports',snapshotId:null};
 return {node,item,native:{orderId:'TEST-order',rework:[window],receiving:undefined}};
};
it('Final10 exact rework and PO use complete effective worker times in the original actual-date consumer',()=>{
 const {node,item,native}=fixture();attachJourneyNativeTimes(item,native,asOf);
 expect(node).toMatchObject({state:'completed',enteredAt:start,actualAt:end,actualQuality:'verified'});
 expect(journeyActualPoint(node,asOf)).toEqual({at:end,precision:'instant',quality:'verified'});
 attachJourneyNativeTimes(item,{...native,rework:[{...native.rework[0]!,complete:false,completedAt:null}]},asOf);
 expect(node).toMatchObject({state:'completed',actualAt:null,actualQuality:'missing'});
 native.rework=[];attachJourneyNativeTimes(item,native,asOf);expect(node).toMatchObject({enteredAt:null,actualAt:null});
});
it.each(['order','rework','line','retired','assignment','missing-own-scope','duplicate-window'])('Final10 never copies a completion from mismatched %s scope',kind=>{
 const {node,item,native}=fixture();
 if(kind==='order')native.orderId='TEST-other';if(kind==='rework')native.rework[0]!.reworkId='TEST-other';if(kind==='line')native.rework[0]!.lineId='TEST-other';if(kind==='retired')node.current=false;
 if(kind==='assignment')native.rework[0]!.assignmentId='TEST-older-assignment';
 if(kind==='duplicate-window')native.rework.push({...native.rework[0]!});
 if(kind==='missing-own-scope')node.records.push({...node.records[0]!,lineId:'TEST-missing-line'});
 attachJourneyNativeTimes(item,native,asOf);expect(node.actualAt).toBeNull();expect(node.enteredAt).toBeNull();
});
it('keeps rework administration active while projecting its completed worker window, never a future A',()=>{
 const first=fixture();first.node.state='active';attachJourneyNativeTimes(first.item,first.native,asOf);expect(first.node).toMatchObject({state:'active',actualAt:end,enteredAt:start,sla:'finished'});
 const second=fixture();second.native.rework[0]!.completedAt='2026-11-06T00:00:00Z';attachJourneyNativeTimes(second.item,second.native,asOf);expect(second.node.actualAt).toBeNull();
});
it('projects running and late-finished rework without using later review/financial registration time',()=>{
 const {node,item,native}=fixture();node.state='active';const window=native.rework[0]!;
 window.deadline=new Date(Date.parse(start)+48*3600000).toISOString();window.snapshotId='TEST-original-policy';window.complete=false;window.completedAt=null;
 const observed=new Date(Date.parse(start)+74*3600000).toISOString();attachJourneyNativeTimes(item,native,observed);
 expect(node).toMatchObject({state:'active',sla:'running',actualAt:null,enteredAt:start});
 window.complete=true;window.completedAt=new Date(Date.parse(start)+50*3600000).toISOString();
 native.rework.push({...window,lineId:'TEST-other-line',reworkId:'TEST-other-rework',complete:false,completedAt:null});
 attachJourneyNativeTimes(item,native,observed);
 expect(node).toMatchObject({state:'active',sla:'finished',actualAt:window.completedAt,enteredAt:start,completionResult:'late',overdueSeconds:7200,nativeWindows:[{completedAt:window.completedAt,deadline:window.deadline,complete:true}]});
 expect(cockpitResponsibilityResult(node)).toEqual({text:'作业超时 2小时',tone:'danger'});
 expect((Date.parse(node.actualAt!)-Date.parse(node.enteredAt!))/3600000).toBe(50);
 expect((Date.parse(node.actualAt!)-Date.parse(window.deadline))/3600000).toBe(2);
});
it('Final10 receiving uses its first effective instant and never assigns midnight to a date-only arrival',()=>{
 const {node,item,native}=fixture();node.key='receipts';node.instanceId='receipts:0';node.state='active';
 const receiving:NonNullable<OrderClosureSheet['receivingSpan']>={firstEffectiveReceipt:{id:'TEST-receipt',receivedAt:start,receivedDate:null,precision:'instant'},history:[],collectedAt:null,elapsedHours:null,reason:null};
 attachJourneyNativeTimes(item,{...native,receiving},asOf);expect(node.enteredAt).toBe(start);
 receiving.firstEffectiveReceipt={id:'TEST-receipt',receivedAt:null,receivedDate:'2026-11-04',precision:'date'};
 attachJourneyNativeTimes(item,{...native,receiving},asOf);expect(node.enteredAt).toBeNull();
});
it('R5 logical cutting convergence uses the latest exact required PO readiness, without inventing a task entry',()=>{
 const lines=[{lineId:'TEST-line-a',cuttingOrderId:'TEST-cut-a'},{lineId:'TEST-line-b',cuttingOrderId:'TEST-cut-b'}];
 const facts=lines.map((line,i)=>({...line,taskId:'TEST-cutting',tracked:true,eventId:'TEST-ready-'+i,effectiveEventId:'TEST-ready-'+i,firstReadyAt:i?end:start,quality:'现场登记',scopeRef:'TEST-po-'+i,basis:[]})) as NativeCuttingReadiness[];
 expect(journeyCuttingGateTime('TEST-cutting',lines,facts,asOf)).toBe(end);
 for(const changed of [facts.slice(0,1),[facts[0]!,{...facts[1]!,taskId:'TEST-other'}],[facts[0]!,{...facts[1]!,cuttingOrderId:'TEST-old-cut'}],[facts[0]!,{...facts[1]!,firstReadyAt:null}],facts.concat(facts[0]!)])expect(journeyCuttingGateTime('TEST-cutting',lines,changed,asOf)).toBeNull();
 expect(journeyCuttingGateTime('TEST-cutting',lines,facts,start)).toBeNull();
});
