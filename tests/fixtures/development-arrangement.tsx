import {TodoReadBoundary} from '../../apps/web/src/todo-content-read.js';
import {useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import type {DigitalTask} from '@dx-rework/contracts/digital-production-tasks';
import {SaveMaterialVerificationSchema,type MaterialVerification} from '@dx-rework/contracts/digital-development-execution';
import {DevelopmentArrangementSchema,type DevelopmentArrangement} from '@dx-rework/contracts/development-arrangement';
import {DevelopmentMaterialCheck} from '../../apps/web/src/development-material-check.js';
import {DevelopmentArrangementPage} from '../../apps/web/src/development-arrangement-page.js';
import {useDevelopmentExecution} from '../../apps/web/src/digital-development-execution-panel.js';
import {useDigitalDetailNavigationGuard} from '../../apps/web/src/use-digital-detail-navigation-guard.js';
import {installInternalNavigation,registerInternalNavigationGuard} from '../../apps/web/src/internal-navigation.js';
import '../../packages/ui/src/tokens.css';
import '../../packages/ui/src/components.css';
import '../../apps/web/src/styles.css';
import '../../apps/web/src/pattern-room.css';
import '../../apps/web/src/digital-development-workspace.css';
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const check:DigitalTask={taskId:id(2),sourceId:id(1),orderId:null,taskKind:'development_materials',label:'核料',assigneeId:id(4),assigneeName:'TEST文员',requiredRole:'development_clerk',state:'ready',routeVersion:1,occurrence:1,enteredAt:null,recordedAt:'2026-10-20T00:00:00Z',completedAt:null,paused:false,dueAt:null,warningAt:null,slaHours:null,policyVersion:1,routeProgress:{applicable:7,completed:0,cancelled:0},hasHandover:true,canManage:true,canCorrect:false,canControl:true,timeQuality:'现场登记',blockedReason:null,canExecute:true};
const plan:DevelopmentArrangement={roundNumber:1,documentVersion:2,version:0,managerId:null,managerName:null,canEdit:true,canTakeOver:true,readyToArrange:false,rows:['pattern','cutting','sewing','tail_check'].map((kind,index)=>({kind:`development_${kind}`,label:['纸样','裁板','车板','尾查'][index]!,requiredRole:index===3?'pattern_room_tail_inspector':'pattern_room_worker',assigneeId:null,assigneeName:null,valid:false,taskId:null,state:null,editable:true}))};
const saved={materialVerification:{version:0,documentVersion:2,taskId:null,note:"",result:"通过",entries:[{materialId:id(3),usage:"use",physical:false,quantity:false,color:false,specification:false,note:"",confirmedWith:"",changedBy:null,changedAt:null,invalidated:[]}]} as MaterialVerification,unifiedArrangement:true,arrangement:plan,sheet:{sourceId:id(1),designStyleNo:'TEST-UNIFIED-DISPATCH',roundNumber:1,latestRoundNumber:1,version:2,canEdit:false,document:{materials:[{materialId:id(3),name:'TEST主布',category:'主布',requiredThisRound:true,specification:'棉布',quantity:'1'}]}},dispatch:null,tasks:[check],facts:[],routeFacts:[],patternOrder:null,canDispatch:true};
const parameters=new URLSearchParams(location.search);
const fixture={reads:0,readBodies:[] as unknown[],saveFailure:parameters.get('saveFailure'),materialWrites:0,navigationBlocked:parameters.has('navigationFailure'),checkFailure:parameters.get('checkFailure'),checkRequests:[] as {key:string;body:unknown}[],saved,checks:0,arrangementWrites:[] as {key:string;body:unknown}[],commits:0,loseResponse:true,failRead:false,unexpected:[] as string[]};
const commands=new Map<string,unknown>();Object.assign(window,{unifiedDispatch:fixture});
window.fetch=async(input,init)=>{
 const path=String(input),method=init?.method??'GET';
 if(parameters.has('readFixture')){
  const arrangement=parameters.has('arrangement'),todoId=id(55),route={routeName:arrangement?'digital_development_arrangement':'digital_production_task',entityId:id(arrangement?1:2),todoId,developmentRound:1};
  if(path.endsWith('/auth/me'))return Response.json({status:'authorized',user:{id:id(4),displayName:'TEST文员',isRoot:false,businessRoles:['development_clerk'],capabilities:['todo:view','digital_production:view']}});
  if(path.endsWith(`/todos/mine/${todoId}/read`)){fixture.reads++;fixture.readBodies.push(JSON.parse(String(init?.body)));return Response.json({read:true,contentToken:'a'.repeat(64),readAt:'2026-10-20T00:00:00.000Z'});}
  if(path.endsWith(`/todos/mine/${todoId}`))return Response.json({todoId,taskTitle:arrangement?'安排本轮师傅':'核料',todoType:'business_action',category:arrangement?'digital_assignment':'digital_task',sourceEventId:todoId,sourceAction:'development_arrangement',entityType:arrangement?'digital_development':'digital_task',entityId:route.entityId,recipientUserId:id(4),requiredRole:null,requiredCapability:null,route,policyKey:null,dueAt:null,reminderCount:0,status:'pending',blockedReason:null,orderContext:null,version:1,createdAt:'2026-10-20T00:00:00.000Z',updatedAt:'2026-10-20T00:00:00.000Z',contentToken:'a'.repeat(64),unread:true});
 }

 if(path.endsWith('/access/candidates'))return Response.json([{id:id(5),displayName:'TEST师傅',roles:['pattern_room_worker']},{id:id(6),displayName:'TEST尾查',roles:['pattern_room_tail_inspector']}]);
 if(path.endsWith('/execution')&&method==='GET'){if(fixture.failRead){fixture.failRead=false;return Response.json({error:{message:'TEST读取失败'}},{status:503});}return Response.json(saved);}
 if(path.endsWith('/execution/material-verification')){fixture.materialWrites++;const body=SaveMaterialVerificationSchema.parse(JSON.parse(String(init?.body)));if(body.expectedVersion!==saved.materialVerification.version)return Response.json({error:{message:'TEST核料版本已变化'}},{status:409});saved.materialVerification={...body,version:body.expectedVersion+1,documentVersion:2,entries:body.entries.map(row=>({...row,changedBy:'TEST文员',changedAt:'2026-10-20T00:00:00Z',invalidated:[]}))};if(fixture.saveFailure==='read'){fixture.saveFailure=null;fixture.failRead=true;}return Response.json({version:saved.materialVerification.version});}
 if(path.endsWith('/execution/check')){
  const key=new Headers(init?.headers).get('idempotency-key')!,body=JSON.parse(String(init?.body));fixture.checkRequests.push({key,body});
  if(commands.has(key))return Response.json(commands.get(key));
  if(fixture.checkFailure==='reject'){fixture.checkFailure=null;return Response.json({error:{message:'TEST核料明确拒绝，输入已保存'}},{status:409});}
  fixture.checks++;check.state='completed';plan.readyToArrange=true;const receipt={taskId:check.taskId};commands.set(key,receipt);
  if(fixture.checkFailure==='unknown'){fixture.checkFailure=null;throw new TypeError('TEST check response lost after commit');}
  if(fixture.checkFailure==='read'){fixture.checkFailure=null;fixture.failRead=true;}
  return Response.json(receipt);
 }
 if(path.endsWith('/execution/arrangement')){
  const body=DevelopmentArrangementSchema.parse(JSON.parse(String(init?.body))),key=new Headers(init?.headers).get('idempotency-key')!;fixture.arrangementWrites.push({key,body});
  if(commands.has(key))return Response.json(commands.get(key));
  if(body.expectedVersion!==plan.version)return Response.json({error:{message:'TEST人员安排已更新'}},{status:409});
  fixture.commits++;plan.version++;for(const row of plan.rows){row.assigneeId=body.entries.find(entry=>entry.kind===row.kind)!.assigneeId;row.valid=Boolean(row.assigneeId);}
  if(body.management==='takeover'){plan.managerId=id(9);plan.managerName='TEST主管';}if(body.management==='release'){plan.managerId=null;plan.managerName=null;}
  const receipt={version:plan.version,roundNumber:1};commands.set(key,receipt);
  if(fixture.loseResponse){fixture.loseResponse=false;throw new TypeError('TEST committed response lost');}return Response.json(receipt);
 }
 fixture.unexpected.push(`${method} ${path}`);throw new Error('Unexpected TEST request');
};
function Check(){const [dirty,setDirty]=useState(false),controller=useDevelopmentExecution({sourceId:id(1),taskId:id(2),workspace:true,onChanged:()=>setDirty(false)});useDigitalDetailNavigationGuard(dirty,controller.busy,controller.writing,'TEST未保存核料');return <main onChange={()=>setDirty(true)}><h1>TEST核料办理</h1>{controller.uncertainWrite&&<button type="button" disabled={controller.busy} onClick={()=>void controller.recheck()}>核对原核料提交结果</button>}{controller.state?<DevelopmentMaterialCheck controller={controller} task={check}/>:<p>读取中…</p>}</main>;}
function Fixture(){const [search,setSearch]=useState(window.location.search);useEffect(()=>{const uninstall=installInternalNavigation('',()=>setSearch(window.location.search)),unguard=registerInternalNavigationGuard(async()=>!fixture.navigationBlocked);return()=>{uninstall();unguard();};},[]);const q=new URLSearchParams(search);return q.has('arrangement')?<DevelopmentArrangementPage sourceId={id(1)} round={Number(q.get('round')??1)} onClose={()=>undefined}/>:<Check/>;}
createRoot(document.getElementById('root')!).render(<TodoReadBoundary><Fixture/></TodoReadBoundary>);
