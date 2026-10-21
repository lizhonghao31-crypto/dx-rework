// Actual product components with synthetic intercepted commands; no business API or database.
import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {DevelopmentExecutionPanel} from '../../apps/web/src/digital-development-execution-panel.js';
import {TaskWorkbenchSample} from '../../apps/web/src/task-workbench-sample.js';
import {canLeaveInternalPage} from '../../apps/web/src/internal-navigation.js';
import {ProductionInstructionPanel} from '../../apps/web/src/production-instruction-panel.js';
import {initialDevelopmentDocument} from '../../apps/web/src/digital-development-editing.js';
import {initialInstruction,type InstructionSheet} from '@dx-rework/contracts/production-instruction';
import {DigitalOrderCreateSchema,type DigitalOrder} from '@dx-rework/contracts/digital-production';
import type {DigitalTask} from '@dx-rework/contracts/digital-production-tasks';
import type {DevelopmentSheet} from '@dx-rework/contracts/digital-development';
import '../../packages/ui/src/tokens.css';
import '../../packages/ui/src/components.css';
import '../../apps/web/src/styles.css';
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const params=new URLSearchParams(location.search),mode=params.get('mode')??'task';
const task:DigitalTask={taskId:id(1),orderId:null,sourceId:id(2),taskKind:'development_pattern',label:'纸样',identity:{designStyleNo:'TEST-FEEDBACK',customerCode:'TEST'},assigneeId:id(3),assigneeName:'TEST 师傅',state:params.has('completed')?'completed':'ready',routeVersion:1,occurrence:1,enteredAt:'2026-10-17T00:00:00Z',recordedAt:'2026-10-17T00:00:00Z',completedAt:params.has('completed')?'2026-10-17T01:00:00Z':null,paused:false,dueAt:null,warningAt:null,slaHours:48,policyVersion:1,routeProgress:{applicable:2,completed:0,cancelled:0},requiredRole:'pattern_room_worker',hasHandover:false,canManage:false,canCorrect:false,canControl:false,timeQuality:'现场登记',blockedReason:null,canExecute:!params.has('completed'),unmetConditions:[]};
if(params.get('taskKind')==='washing'){task.taskKind='development_washing_dispatch';task.label='送洗';}if(params.get('taskKind')==='supply'){task.taskKind='development_material_supply';task.label='补料';}
const development:DevelopmentSheet={sourceId:id(2),designStyleNo:'TEST-FEEDBACK',temporaryStyleNo:null,customerCode:'TEST',developmentType:'头版',designerName:'TEST 设计师',version:2,status:'published',document:{...initialDevelopmentDocument(),quantity:1,sizeQuantities:[1,0],sampleSize:'M',instructions:'TEST 制作说明'},publishedAt:'2026-10-17T00:00:00Z',taskId:id(1),canEdit:false,materialEvents:[],roundNumber:1,latestRoundNumber:1};
const order:DigitalOrder={...DigitalOrderCreateSchema.parse({customerCode:'PD',productGroup:'男装',designStyleNo:'TEST-INSTRUCTION',orderDate:'2026-10-17',lines:[{color:'黑',sizes:[{size:'M',quantity:10}],customerWarehouseArrivalDate:'2099-12-31'}]}),productionOrderId:id(5),sourceId:id(2),createdBy:id(3),createdAt:'2026-10-17T00:00:00Z',version:1,lines:[{lineId:id(6),color:'黑',colorForeign:null,poNumber:'TEST-PO',formalStyleNo:'TEST-PO',temporaryStyleNo:null,deliveryDate:'2099-12-31',sizes:[{size:'M',quantity:10}]}]};
const instruction:InstructionSheet={order,currentOrderVersion:1,currentDeliveryDate:null,version:1,publishedVersion:null,versions:[],isPublishedSnapshot:false,canEdit:true,cutStarted:false,merchandiserName:'TEST 跟单',sourceRound:1,latestSourceRound:1,canApproveDate:false,printedBy:'TEST',dateRequests:[],document:{...initialInstruction(),styleName:'TEST 款名',category:'上衣',date:'2026-10-17',preshrink:'无需预缩',sizes:['M'],measurements:[{id:id(7),name:'胸围',tolerance:'',method:'',values:['60']}],images:[{attachmentId:id(8),kind:'款图',description:'TEST'}]}};
const state={task,development,instruction,requests:[] as {path:string;method:string;body:unknown;key:string|null}[],failNextWrite:false,failNextExecutionRead:false,uploadCount:0,completionCount:0};
Reflect.set(window,'operationFeedbackFixture',state);
Object.assign(window,{feedbackLeaveResult:null,checkFeedbackLeave:async()=>{Reflect.set(window,'feedbackLeaveResult',await canLeaveInternalPage());}});
const execution=()=>({sheet:state.development,tasks:[state.task,...(state.task.state==='completed'?[{...state.task,taskId:id(9),taskKind:'development_cutting',label:'裁板',state:'pending',canExecute:false,assigneeName:null,enteredAt:null,completedAt:null}]:[])],patternOrder:null,routeFacts:[],dispatch:null,facts:state.completionCount?[{factId:id(10),taskId:id(1),kind:'纸样完成',payload:{attachmentIds:[id(4)]},recordedAt:'2026-10-17T01:00:00Z'}]:[],canReportFabric:false,canDispatch:false,canDecideFabric:false,qrAvailable:false});
window.fetch=async(input,init)=>{
 const path=String(input),method=init?.method??'GET';
 if(path==='https://fixture.invalid/upload'){state.uploadCount++;return new Response(null,{status:204});}
 const body=init?.body?JSON.parse(String(init.body)):null;state.requests.push({path,method,body,key:new Headers(init?.headers).get('idempotency-key')});
 const pathname=new URL(path,location.href).pathname;
 if(method!=='GET'&&state.failNextWrite){state.failNextWrite=false;return Response.json({error:{message:'TEST 业务前置未满足，输入保留'}},{status:409});}
 if(pathname.endsWith(`/sources/${id(2)}/execution`)){
  if(state.failNextExecutionRead){state.failNextExecutionRead=false;return Response.json({error:{message:'TEST 暂时无法读取'}},{status:503});}
  return Response.json(execution());
 }
 if(pathname.endsWith('/execution/upload-limits'))return Response.json({maxUploadBytes:1000000});
 if(pathname.endsWith('/execution/upload-intents'))return Response.json({attachmentId:id(4),uploadUrl:'https://fixture.invalid/upload',uploadMethod:'POST',uploadFields:{}});
 if(pathname.endsWith('/finalize'))return Response.json({});
 if(['/execution/complete','/execution/send-washing','/execution/resubmit'].some(path=>pathname.endsWith(path))){state.completionCount++;state.task={...state.task,state:'completed',completedAt:'2026-10-17T01:00:00Z',canExecute:false};return Response.json({taskId:id(1)});}
 if(pathname.endsWith(`/tasks/${id(1)}/feedback`)){state.task={...state.task,state:body.blocked?'blocked':'ready',blockedReason:body.blocked?body.reason:null};return Response.json(state.task);}
 if(pathname.endsWith(`/tasks/${id(1)}/history`))return Response.json({events:[]});
 if(pathname.endsWith(`/tasks/${id(1)}/documents`))return Response.json({development:{state:'published',id:id(2),version:1,label:'本次采用'},instruction:{state:'not_applicable'},budget:{state:'not_applicable'}});
 if(pathname.endsWith(`/sources/${id(2)}/development`))return Response.json(state.development);
 if(pathname.endsWith(`/orders/${id(5)}/instruction`)||pathname.endsWith(`/orders/${id(5)}/instruction/publish`)){
  if(method==='PUT'){state.instruction={...state.instruction,version:state.instruction.version+1,document:body.document};}
  if(pathname.endsWith('/publish')){state.instruction={...state.instruction,publishedVersion:state.instruction.version,versions:[state.instruction.version]};}
  const version=new URL(path,location.href).searchParams.get('version');
  return Response.json(version?{...state.instruction,isPublishedSnapshot:true,canEdit:false}:state.instruction);
 }
 throw new Error(`Unexpected intercepted request: ${method} ${path}`);
};
function Fixture(){const [generation,setGeneration]=useState(0);return <><button onClick={()=>setGeneration(value=>value+1)}>TEST 重新打开</button>{mode==='execution'?<DevelopmentExecutionPanel key={generation} sourceId={id(2)} taskId={id(1)} workspace/>:mode==='instruction'?<ProductionInstructionPanel key={generation} orderId={id(5)} onClose={()=>{}}/>:<TaskWorkbenchSample key={generation} task={state.task} onClose={()=>{}}/>}</>;}
createRoot(document.getElementById('root')!).render(<Fixture/>);
