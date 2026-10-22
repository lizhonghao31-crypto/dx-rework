// Actual App/MyTodosPage; synthetic reads retain the original actor header.
import {createRoot} from 'react-dom/client';
import {App} from '../../apps/web/src/App.js';
import {verifySession} from '../../apps/web/src/auth.js';
import type {TodoResponse} from '@dx-rework/contracts';
import '@dx-rework/ui/tokens.css';
import '@dx-rework/ui/components.css';
import '../../apps/web/src/styles.css';
import '../../apps/web/src/workflow-shell.css';
import '../../apps/web/src/dialog-visual-system.css';
import '../../apps/web/src/workflow-state-visual.css';
import '../../apps/web/src/ui-polish.css';
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const scenario=sessionStorage.getItem('dx-erp:todo-test-scenario')??'success',requests:{path:string;method:string;body:unknown}[]=[];let transferred=false,readCount=0;
const context={reworkNo:'TEST-RW-001',orderNo:'TEST-PO-001',styleNo:'TEST 深蓝长款风衣',supplierName:'TEST 原加工厂',status:'pending_work_reporting',updatedAt:'2026-10-17T00:00:00Z'};
const todo:TodoResponse={todoId:id(13),todoType:'recipient_routing_exception',category:'recipient_routing_exception',sourceEventId:id(14),sourceAction:'todo.recipient_blocked',entityType:'rework_order',entityId:id(15),recipientUserId:id(100),requiredRole:'production_management',requiredCapability:'todo:routing_exception_manage',route:{routeName:'rework_detail',entityId:id(15),todoId:id(13),tab:'work_reporting'},policyKey:'general',dueAt:null,reminderCount:0,status:'pending',blockedReason:null,orderContext:context,version:1,createdAt:'2026-10-17T00:00:00Z',updatedAt:'2026-10-17T00:00:00Z'};
const digital=scenario.startsWith('digital-');
if(digital)Object.assign(todo,{todoType:scenario==='digital-action'?'business_action':'recipient_routing_exception',category:scenario==='digital-action'?'digital_task':'digital_assignment',sourceAction:'digital_task',sourceEventId:todo.todoId,entityType:'digital_task',entityId:todo.todoId,requiredRole:'pattern_room_worker',requiredCapability:null,taskTitle:scenario==='digital-action'?'TEST 数字任务办理':'TEST 数字任务待指派',status:scenario==='digital-action'?'pending':'blocked_recipient',blockedReason:scenario==='digital-action'?null:'主办缺失或已失效，请重新分配',orderContext:scenario==='digital-action'?context:null,route:{routeName:'digital_production_task',entityId:todo.todoId,todoId:todo.todoId}});
if(scenario==='digital-assignment-context')Object.assign(todo,{orderContext:{...context,poNumbers:['TEST-ROUTING-PO']},route:{...todo.route,developmentRound:2}});
const exception={routingExceptionId:id(18),todoId:id(12),routingTodoId:id(13),originalRecipientUserId:id(200),assignedToUserId:id(100),status:'pending',reason:'recipient_disabled',resolutionReason:null,createdAt:'2026-10-17T00:00:00Z',updatedAt:'2026-10-17T00:00:00Z'};
Object.assign(window,{todoTransferFixture:{requests,scenario,identityChanged:false}});
window.sessionStorage.setItem('dx-rework:platform-module','rework');
window.fetch=async(input,init)=>{
 await new Promise(resolve=>window.setTimeout(resolve,0));
 const url=new URL(String(input),location.origin),method=init?.method??'GET',body=init?.body?JSON.parse(String(init.body)):null;requests.push({path:url.pathname+url.search,method,body});
 const identityChanged=(window as unknown as {todoTransferFixture:{identityChanged:boolean}}).todoTransferFixture.identityChanged;
 if(url.pathname.endsWith('/auth/me'))return Response.json({status:'authorized',user:{id:id(identityChanged?101:100),displayName:'TEST 供应链管理人',isRoot:scenario==='root',businessRoles:scenario==='role-forbidden'?['pattern_room_worker']:['production_management'],capabilities:['todo:view',...(['viewer','digital-assignment-viewer'].includes(scenario)?[]:['todo:routing_exception_manage'])]}});
 if(url.pathname.endsWith('/todos/mine/indicator'))return Response.json({pendingCount:transferred?0:1},{headers:{'x-dx-rework-actor-id':id(identityChanged?101:100)}});
 if(url.pathname.includes('/digital-production/notifications/'))return Response.json({error:{message:'TEST 通知不在本场景范围'}},{status:404});
 if(method==='POST'&&url.pathname.endsWith('/routing-exceptions/'+id(18)+'/transfer')){
  if(scenario==='unknown'||scenario==='unknown-gone'){if(scenario==='unknown-gone')transferred=true;throw TypeError('TEST simulated lost response');}
  if(scenario==='invalid-json')return new Response('not-json',{status:200,headers:{'content-type':'application/json'}});
  if(scenario==='forbidden'||scenario==='inactive-recipient'||body.recipientUserId===id(301))return Response.json({error:{code:'FORBIDDEN',message:'New recipient lacks the required active authority'}},{status:403});
  if(scenario==='conflict')return Response.json({error:{code:'INVALID_STATE_TRANSITION',message:'Todo routing exception is no longer pending'}},{status:409});
  transferred=true;return Response.json({...todo,todoId:id(12),todoType:'business_action',category:'work_reporting',recipientUserId:body.recipientUserId,requiredRole:'worker',requiredCapability:'work:report',route:{...todo.route,todoId:id(12)}});
 }
 if(method!=='GET')return Response.json({error:{message:'TEST 未授权的合成写入'}},{status:403});
 if(url.pathname.endsWith('/todos/mine'))return Response.json({todos:transferred||identityChanged?[]:[todo],activeModule:digital?'digital_production':'rework',moduleCounts:{rework:digital||transferred||identityChanged?0:1,sourcing:0,...(digital?{digital_production:1}:{})},page:1,pageSize:15,totalCount:transferred||identityChanged?0:1,totalPages:1});
 if(url.pathname.endsWith('/todos/routing-exceptions/mine')){readCount++;if(scenario==='routing-read-denied')return Response.json({error:{message:'TEST forbidden'}},{status:403});if(scenario==='read-failure'&&readCount===1)return Response.json({error:{message:'TEST 合成转交事项读取失败'}},{status:503});return Response.json({routingExceptions:transferred||scenario==='other-manager'||digital?[]:[exception]});}
 if(url.pathname.endsWith('/digital-production/access/candidates'))return Response.json(scenario==='empty-candidates'?[]:[{id:id(300),displayName:'TEST 王师傅',roles:['worker']},{id:id(301),displayName:'TEST 跟单',roles:['order_merchandiser']}]);
 throw Error('Unexpected todo transfer fixture request: '+url.pathname);
};
void verifySession().then(()=>createRoot(document.getElementById('root')!).render(<App/>));
