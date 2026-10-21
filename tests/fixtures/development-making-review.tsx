import '../../apps/web/src/App.js';
import {createRoot} from 'react-dom/client';
import {useState} from 'react';
import {DevelopmentExecutionPanel} from '../../apps/web/src/digital-development-execution-panel.js';
import {PatternOrderExceptions} from '../../apps/web/src/pattern-order-exceptions.js';
import {PatternOrderForm} from '../../apps/web/src/pattern-order-form.js';
import {initialDevelopmentDocument} from '../../apps/web/src/digital-development-editing.js';
import {developmentMakingBasis} from '@dx-rework/contracts/digital-development';
import {PatternOrderDetailSchema} from '@dx-rework/contracts/pattern-orders';
import type {DigitalTask} from '@dx-rework/contracts/digital-production-tasks';
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,now='2026-10-20T00:00:00Z',mode=new URLSearchParams(location.search).get('mode')??'tail';
const document={...initialDevelopmentDocument(),quantity:3,sizes:['M','L'],measurements:[],materials:[]};delete document.documentFormatVersion;delete document.sizeQuantities;
const task:DigitalTask={taskId:id(2),sourceId:id(1),orderId:null,taskKind:'development_tail_check',label:'尾查',requiredRole:'pattern_room_tail_inspector',assigneeId:id(3),assigneeName:'TEST尾查',routeVersion:1,occurrence:1,state:'ready',canExecute:true,enteredAt:now,recordedAt:now,completedAt:null,paused:false,dueAt:null,warningAt:null,slaHours:4,policyVersion:1,routeProgress:{applicable:7,completed:5,cancelled:0},hasHandover:false,canManage:false,canControl:false,canCorrect:false,timeQuality:'现场登记',blockedReason:null,unmetConditions:[]};
const original=structuredClone(document),state={unifiedArrangement:true,sheet:{sourceId:id(1),designStyleNo:'TEST-P03-LEGACY',roundNumber:1,version:2,status:'published',canEdit:false,document,materialEvents:[]},tasks:[task],facts:[],routeFacts:[],patternOrder:null,canDispatch:false,canReportFabric:false,canDecideFabric:false};
const actions={assign:false,complete:false,handoff:false,edit:true,hours:false,rework:true,transfer:false,cancel:false,cancelFees:false};
const order=PatternOrderDetailSchema.parse({orderId:id(4),orderNo:'TEST',kind:'pattern',taskName:null,status:mode==='update'?'pending_assignment':'pending_confirmation',version:1,styleNo:'TEST',creatorId:id(3),creatorName:'TEST设计师',currentWorkerName:null,requiredDate:null,reworkCount:0,submittedAt:now,updatedAt:now,developmentSourceId:id(1),developmentMakingBasis:developmentMakingBasis(document,2),currentRoundId:id(5),customer:null,sizeColor:'TEST各码制作'.repeat(40),referenceStyleNo:null,variant:null,note:'TEST原备注',rounds:[{roundId:id(5),index:0,roundType:'initial',requestedBy:id(3),requestReason:null,status:'pending_confirmation',categoryName:'TEST品类',unit:'件',quantity:3,assignedAt:now,completedAt:now,handedOverAt:null,stoppedAt:null,cancelledAt:null,feeConfirmedAt:null,segments:[],nodes:[]}],attachments:[{attachmentId:id(6),roundId:id(5),filename:'TEST.png',mimeType:'image/png',sizeBytes:1,active:true,addedAt:now,reason:'TEST原资料'}],history:[],actions});
const fixture={original,requests:[] as {path:string;method:string;body:unknown}[],saved:false};Object.assign(window,{makingReviewFixture:fixture});
window.fetch=async(input,init)=>{const url=new URL(String(input),location.origin),method=init?.method??'GET',body=init?.body?JSON.parse(String(init.body)):null;fixture.requests.push({path:url.pathname,method,body});
 if(method==='GET'&&url.pathname.endsWith('/execution'))return Response.json(state);
 if(method==='POST'&&url.pathname.endsWith('/execution/route')){fixture.saved=true;task.state='completed';task.canExecute=false;return Response.json({taskId:task.taskId});}
 if(method==='POST'&&(url.pathname.endsWith('/rework')||url.pathname.endsWith('/materials'))){fixture.saved=true;return Response.json(order);}
 throw Error(`Unexpected making review request: ${method} ${url.pathname}`);
};
function Fixture(){const [saved,setSaved]=useState(false),[busy,setBusy]=useState(false);return <main><h1>TEST 制作数量升级入口</h1>{saved?<p>TEST已取得保存回执</p>:mode==='tail'?<DevelopmentExecutionPanel sourceId={id(1)} taskId={task.taskId} workspace/>:mode==='update'?<PatternOrderForm order={order} onSaved={()=>setSaved(true)} onCancel={()=>undefined}/>:<PatternOrderExceptions order={order} active="rework" onActive={()=>undefined} busy={busy} onBusy={setBusy} onSaved={()=>setSaved(true)}/>}</main>;}
createRoot(window.document.getElementById('root')!).render(<Fixture/>);
