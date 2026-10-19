// Actual product hosts, controlled synthetic read responses, no live services.
import {createRoot} from 'react-dom/client';
import {DigitalPatternWorkspace} from '../../apps/web/src/digital-pattern-workspace.js';
import {BulkPatternWorkspace} from '../../apps/web/src/bulk-pattern-workspace.js';
import {TaskWorkbenchSample} from '../../apps/web/src/task-workbench-sample.js';
import {DevelopmentExecutionPanel} from '../../apps/web/src/digital-development-execution-panel.js';
import {DevelopmentDocumentFacts} from '../../apps/web/src/development-document-facts.js';
import {OrderDocumentContainer} from '../../apps/web/src/order-document-container.js';
import {initialDevelopmentDocument} from '../../apps/web/src/digital-development-editing.js';
import {PATTERN_GROUPS} from '@dx-rework/contracts/digital-development-workspace';
import type {DigitalTask} from '@dx-rework/contracts/digital-production-tasks';
import '../../packages/ui/src/tokens.css';
import '../../packages/ui/src/components.css';
import '../../apps/web/src/styles.css';
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,now='2026-10-17T00:00:00.000Z';
const params=new URLSearchParams(location.search),scenario=params.get('case')??'config',mode=location.pathname.slice(1).split('/')[0],status=Number(params.get('status')??503);
const task:DigitalTask={taskId:id(1),orderId:null,sourceId:id(2),taskKind:'development_washing_dispatch',label:'送洗',identity:{designStyleNo:'TEST-READ',customerCode:'TEST'},assigneeId:id(3),assigneeName:'TEST 师傅',state:'completed',routeVersion:1,occurrence:1,enteredAt:now,recordedAt:now,completedAt:now,paused:false,dueAt:null,warningAt:null,slaHours:48,policyVersion:1,routeProgress:{applicable:1,completed:1,cancelled:0},requiredRole:'pattern_room_worker',hasHandover:false,canManage:false,canCorrect:false,canControl:false,timeQuality:'现场登记',blockedReason:null,canExecute:false,unmetConditions:[]};
const sheet={sourceId:id(2),designStyleNo:'TEST-READ',temporaryStyleNo:null,customerCode:'TEST',developmentType:'头版',designerName:'TEST',version:1,status:'published',document:initialDevelopmentDocument(),publishedAt:now,taskId:id(1),canEdit:false,materialEvents:[],roundNumber:1,latestRoundNumber:1};
const state={requests:[] as {path:string;method:string}[],unexpected:[] as string[],configFailures:scenario==='config'?1:0,listFailures:['list','bulk-draft'].includes(scenario)?1:0,executionFailures:scenario==='execution'?1:0,candidateFailures:scenario==='candidate'?1:0,sheetFailures:scenario==='sheet'?1:0,directoryFailures:scenario==='directory'?1:0,slowSettled:false,releaseSlow:null as (()=>void)|null};Reflect.set(window,'readRecoveryFixture',state);
const failure=()=>{if(status===0)throw new TypeError('TEST network disconnected');return Response.json({error:{message:status===403?'TEST 当前范围无查看权限':status===404?'TEST 原记录当前不可见':'TEST 服务读取失败'}},{status});};
window.fetch=async(input,init)=>{
 const url=new URL(String(input),location.href),path=url.pathname,method=init?.method??'GET';state.requests.push({path:path+url.search,method});
 if(method!=='GET'){state.unexpected.push(method+' '+path);return Response.json({error:{message:'TEST 仅允许读取'}},{status:403});}
 if(path.endsWith('/access/options')){if(state.configFailures-->0)return failure();return Response.json({manage:true,customers:false,approveDelivery:false,create:false,actorId:id(3),roles:['root_superuser']});}
 if(path.endsWith('/workspaces/pattern')){if(url.searchParams.get('search')==='slow-error')await new Promise<void>(resolve=>{state.releaseSlow=resolve;});if(url.searchParams.get('search')==='slow-error'){state.slowSettled=true;return failure();}if(state.listFailures-->0)return failure();return Response.json({asOf:now,page:1,pageSize:15,total:0,archiveTotal:0,counts:Object.fromEntries(PATTERN_GROUPS.map(group=>[group.key,0])),riskCounts:Object.fromEntries(PATTERN_GROUPS.map(group=>[group.key,{dueSoon:0,overdue:0}])),owners:[],items:[]});}
 if(path.endsWith('/workspaces/bulk-pattern')){if(state.listFailures-->0)return failure();return Response.json({page:1,pageSize:15,total:0,items:[]});}
 if(path.endsWith('/execution')){if(state.executionFailures-->0)return failure();return Response.json({sheet,tasks:[task],patternOrder:null,routeFacts:[{factId:id(9),routeVersion:1,taskId:null,kind:'最终设计确认',payload:{note:'TEST 已确认'},recordedAt:now}],dispatch:null,facts:[],canReportFabric:false,canDispatch:scenario==='candidate',canDecideFabric:false,qrAvailable:false});}
 if(path.endsWith('/bulk-preparation'))return Response.json({preparationId:id(6),reference:null,adoptedRound:1,sourceRound:1,instructionVersion:1,instructionValid:true,customerConfirmed:true,ownerApproved:true,preshrink:'不需要',canDispatchPattern:true,canDispatchWarehouse:true,dispatch:{version:0,patternWorkerId:null,warehouseWorkerId:null,cuttingWorkerId:null},reasons:[],tasks:[],facts:[],cutting:{mode:'in_house',completed:false,lines:[]}});
 if(path.endsWith('/access/candidates')){if(state.candidateFailures-->0)return failure();return Response.json(scenario==='bulk-draft'?[{id:id(3),displayName:'TEST 纸样',roles:['pattern_room_worker']},{id:id(4),displayName:'TEST 预缩',roles:['warehouse_receiver']},{id:id(5),displayName:'TEST 裁床',roles:['cutting_worker']}]:[]);}
 if(path.includes('/document-directory/')){if(state.directoryFailures-->0)return failure();return Response.json({development:{state:'available',id:id(2),version:1},instruction:{state:'not_applicable'},budget:{state:'not_applicable'}});}
 if(path.endsWith('/development/rounds'))return Response.json({rounds:[],draft:null});
 if(path.endsWith('/development')){if(state.sheetFailures-->0)return failure();return Response.json(sheet);}
 state.unexpected.push(method+' '+path);return Response.json({error:{message:'TEST 未配置读取'}},{status:404});
};
const content=mode==='bulk'?<BulkPatternWorkspace orderId={scenario==='bulk-draft'?id(5):null} canViewAll/>:mode==='task'?<TaskWorkbenchSample task={task} onClose={()=>{}}/>:mode==='execution'?<DevelopmentExecutionPanel sourceId={id(2)} taskId={id(1)} workspace/>:mode==='facts'?<DevelopmentDocumentFacts sourceId={id(2)} round={1} category="customer"/>:mode==='directory'?<OrderDocumentContainer initial={{kind:'development',id:id(2),version:1}} onClose={()=>{}}/>:<DigitalPatternWorkspace/>;
createRoot(document.getElementById('root')!).render(content);
