import '../../apps/web/src/App.js';
import {createRoot} from 'react-dom/client';
import {PatternRoomExecutionWorkspace} from '../../apps/web/src/pattern-room-orders-page.js';
import {PatternOrderDetailSchema} from '@dx-rework/contracts/pattern-orders';
import type {DevelopmentArrangement} from '@dx-rework/contracts/development-arrangement';
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,now='2026-10-20T00:00:00Z';
const mode=new URLSearchParams(location.search).get('mode')??'rework',pending=mode==='rework'||mode==='initial';
const actions={assign:pending,complete:!pending,handoff:false,edit:false,hours:false,rework:false,transfer:!pending,cancel:false,cancelFees:false};
const order=PatternOrderDetailSchema.parse({orderId:id(4),orderNo:'TEST-P05',kind:'pattern',taskName:null,status:pending?'pending_assignment':'in_progress',version:1,styleNo:'TEST-P05',creatorId:id(3),creatorName:'TEST设计师',currentWorkerName:pending?null:'TEST原师傅',requiredDate:null,reworkCount:0,submittedAt:now,updatedAt:now,developmentSourceId:id(1),currentRoundId:id(5),customer:null,sizeColor:'M：1件',referenceStyleNo:null,variant:null,note:'TEST原执行资料',rounds:[{roundId:id(5),index:mode==='rework'?null:0,roundType:mode==='initial'?'initial':'rework',requestedBy:id(3),requestReason:null,status:pending?'pending_assignment':'in_progress',categoryName:'TEST品类',unit:'件',quantity:1,unitPrice:'10.00',agreedAmount:'10.00',assignedAt:pending?null:now,completedAt:null,handedOverAt:null,stoppedAt:null,cancelledAt:null,feeConfirmedAt:null,segments:pending?[]:[{segmentId:id(7),index:1,workerUserId:id(8),workerName:'TEST原师傅',personId:id(9),personType:'internal',amount:'10.00',actualHours:null,startedAt:now,endedAt:null,wageEligible:false}],nodes:[]}],attachments:[],history:[],actions});
const plan:DevelopmentArrangement={roundNumber:2,documentVersion:3,version:4,managerId:null,managerName:null,canEdit:true,canTakeOver:true,readyToArrange:true,rows:[{kind:'development_sewing',label:'车板',requiredRole:'pattern_room_worker',assigneeId:id(8),assigneeName:'TEST原师傅',valid:true,taskId:id(2),state:'ready',editable:true}]};
const fixture={mode,requests:[] as {path:string;method:string;key:string|null;body:unknown}[],commits:0,receiptReads:0,changed:0};Object.assign(window,{executionWorkspaceFixture:fixture});
window.fetch=async(input,init)=>{
 const url=new URL(String(input),location.origin),method=init?.method??'GET',body=init?.body?JSON.parse(String(init.body)):null,key=new Headers(init?.headers).get('idempotency-key');fixture.requests.push({path:url.pathname,method,key,body});
 if(method==='GET'&&url.pathname.endsWith('/workers'))return Response.json([{personId:id(10),userId:id(11),name:'TEST接手师傅'}]);
 if(method==='GET'&&url.pathname.endsWith(`/orders/${id(4)}`))return Response.json(order);
 if(method==='POST'&&url.pathname.endsWith('/assign')){fixture.commits++;order.status='in_progress';order.actions.assign=false;order.version++;return Response.json(order);}
 if(method==='POST'&&url.pathname.endsWith('/transfer-execution')){
  if(fixture.requests.filter(r=>r.method==='POST').length===1){if(mode!=='retry')fixture.commits++;throw new TypeError('TEST sent write response lost');}
  fixture.commits++;order.version++;order.currentWorkerName='TEST接手师傅';return Response.json(order);
 }
 if(method==='GET'&&url.pathname.endsWith('/transfer-execution/receipt')){fixture.receiptReads++;if(mode==='retry')return Response.json({receipt:null,committedVersion:null});order.version=mode==='later'?3:2;order.currentWorkerName=mode==='later'?'TEST后来师傅':'TEST接手师傅';return Response.json({receipt:order,committedVersion:2});}
 throw Error(`Unexpected execution workspace request: ${method} ${url.pathname}`);
};
createRoot(document.getElementById('root')!).render(<main><h1>TEST 总委派特殊办理宿主</h1><PatternRoomExecutionWorkspace orderId={id(4)} developmentContext={{sourceId:id(1),plan}} onChanged={()=>fixture.changed++}/></main>);
