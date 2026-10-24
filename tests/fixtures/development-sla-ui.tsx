import '@dx-rework/ui/tokens.css';
import '@dx-rework/ui/components.css';
import '../../apps/web/src/styles.css';
import '../../apps/web/src/workflow-shell.css';
import '../../apps/web/src/dialog-visual-system.css';
import '../../apps/web/src/workflow-state-visual.css';
import '../../apps/web/src/ui-polish.css';
import {TaskWorkbenchSample} from '../../apps/web/src/task-workbench-sample.js';
import type {DigitalTask} from '@dx-rework/contracts/digital-production-tasks';
import '../../apps/web/src/App.js';
import {createRoot} from 'react-dom/client';
import {Surface} from '@dx-rework/ui';
import {useDevelopmentExecution} from '../../apps/web/src/digital-development-execution-panel.js';
import {DevelopmentAssignmentTable} from '../../apps/web/src/development-assignment-table.js';
import {DevelopmentExternalPattern} from '../../apps/web/src/development-external-pattern.js';
import {DigitalDevelopmentPanel} from '../../apps/web/src/digital-development-panel.js';
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const mode=new URLSearchParams(location.search).get('mode')??'prewash';
const kinds:Record<string,string>={prewash:'development_pre_wash_check',tail:'development_tail_check',nowash:'development_tail_check',cut:'development_cutting',external:'development_external_pattern',readonly:'development_external_pattern',request:'development_pattern'};
const kind=kinds[mode]??'development_pattern',label=({prewash:'洗前尺寸检查',tail:'最终尾查',nowash:'最终尾查',cut:'固定裁板',external:'外部纸样跟进',readonly:'外部纸样跟进'} as Record<string,string>)[mode]??'纸样';
const document={documentFormatVersion:2 as const,sizeQuantities:[1,1,1],template:'上衣' as const,quantity:3,sampleSize:'M',orderDate:'2026-10-23',returnDate:null,unit:'cm' as const,sizes:['S','M','L'],measurements:[{name:'胸围（平量一圈）',values:['90','94','98']},{name:'后中衣长（不含领）',values:['60','62','64']}],interlining:'',placketInterlining:'',sewingThread:'',buttonholeThread:'',stitchDensity:'',washingIroning:'',packaging:'',formalSizes:'',casualSizes:'',mainLabel:false,mainLabelMethod:'',sizeLabel:false,careLabel:false,instructions:'按开发单确认部位记录；长备注用于检查窄屏换行。',craft:'无' as const,washing:mode==='nowash'?'免洗' as const:'内洗' as const,materials:[],files:[]};
const task={taskId:id(2),sourceId:id(1),orderId:null,taskKind:kind,label,assigneeId:id(3),assigneeName:'TEST 实际办理人',requiredRole:'pattern_room_tail_inspector',state:mode==='readonly'?'completed':'ready',routeVersion:1,occurrence:1,canExecute:!['readonly','request','fixed'].includes(mode),canManage:false,canCorrect:false,canControl:false,paused:false,enteredAt:'2026-10-23T00:00:00Z',dueAt:'2026-10-25T00:00:00Z',completedAt:null,recordedAt:'2026-10-23T00:00:00Z',warningAt:'2026-10-24T09:36:00Z',slaHours:48,policyVersion:1,timeQuality:'现场登记',blockedReason:null,hasHandover:false,routeProgress:{applicable:9,completed:4,cancelled:0}};
const sheet={sourceId:id(1),productionOrderId:null,designStyleNo:mode==='revision'?'TEST 领口衬衫 · 复版2':'TEST 开发衬衫',temporaryStyleNo:null,customerCode:'PD',developmentType:'头版',designerName:'TEST 设计师',version:2,status:'published',document,publishedAt:'2026-10-23T00:00:00Z',taskId:id(2),canEdit:false,canRevise:false,roundNumber:1,latestRoundNumber:1,materialEvents:[],independentRevisions:true,...(mode==='revision'?{revisionSource:{sourceId:id(1),parentSourceId:id(12),rootSourceId:id(13),revisionNumber:2,parentRound:1,origin:'客户新增要求',customerComment:'领口加宽，胸围调整；保留原单数量，不复制原单已完成事实。',explanation:'按客户原评语重新制作',categories:['尺寸','版型'],affectedNodes:['纸样','裁板','车板'],outputKind:'整件样板'}}:{})};
const state={sheet,tasks:[task],slaEnrolled:true,canRequestExternalPattern:mode==='request',externalPatterns:mode==='request'?[]:[{requestId:id(8),roundNumber:1,requestedAt:'2026-10-23T00:00:00Z',requestedBy:'TEST 技术主管',receivedAt:mode==='readonly'?'2026-10-24T00:00:00Z':null,receivedBy:mode==='readonly'?'TEST 技术主管':null,note:'确认领口和袖笼纸样，请按指定比例提交。',receiptNote:null,attachmentIds:mode==='readonly'?[id(9)]:null,taskId:id(2)}],fixedCutting:{version:0,assigneeId:null,assigneeName:null,valid:false,canConfigure:true},sewingRecipientName:'TEST 接收车板师傅（名字较长用于换行检查）',arrangement:{roundNumber:1,documentVersion:2,version:1,managerId:null,managerName:null,canEdit:true,canTakeOver:false,readyToArrange:true,rows:[{kind:'development_pattern',label:'纸样',requiredRole:'pattern_room_worker',assigneeId:id(3),assigneeName:'TEST 师傅',valid:true,taskId:null,state:null,editable:true},{kind:'development_cutting',label:'裁板',requiredRole:'pattern_room_worker',assigneeId:null,assigneeName:null,valid:false,taskId:null,state:null,editable:false,fixed:true}]},dispatch:null,routeFacts:[],facts:[],canDispatch:mode==='fixed',canReportFabric:false,canDecideFabric:false,qrAvailable:false,patternOrder:null,unifiedArrangement:true};
if(mode==='external')state.externalPatterns.unshift({...state.externalPatterns[0]!,requestId:id(18),requestedAt:'2026-10-21T00:00:00Z',receivedAt:'2026-10-22T00:00:00Z',receivedBy:'TEST 技术主管',taskId:id(19)});
const evidence={requests:[] as {path:string;method:string;body:unknown}[]};Object.assign(window,{slaUiEvidence:evidence});
window.fetch=async(input,init)=>{
 const url=new URL(String(input),location.origin),method=init?.method??'GET',body=init?.body?JSON.parse(String(init.body)):null;evidence.requests.push({path:url.pathname,method,body});
 if(method==='GET'&&url.pathname.endsWith('/execution'))return Response.json(state);
 if(method==='GET'&&url.pathname.endsWith('/development'))return Response.json(sheet);
 if(method==='GET'&&url.pathname.endsWith('/rounds'))return Response.json({rounds:[],draft:null});
 if(method==='GET'&&url.pathname.endsWith('/amendment/history'))return Response.json({amendments:[]});
 if(method==='GET'&&url.pathname.endsWith('/access/candidates'))return Response.json([{id:id(3),displayName:'TEST 师傅',roles:['pattern_room_worker']}]);
 if(method==='POST'&&url.pathname.endsWith('/route')){
  if(mode==='tail'||mode==='nowash')return Response.json({error:{code:'DEVELOPMENT_EXECUTION_CONFLICT',message:'尾查提交前请上传本任务实际照片'}},{status:409});
  task.state='completed';return Response.json({taskId:id(2)});
 }
 if(method==='POST'&&url.pathname.endsWith('/external-pattern'))return Response.json({requestId:id(8)});
 if(method==='POST'&&url.pathname.includes('content-read'))return Response.json({ok:true});
 throw Error(`Unexpected SLA UI request ${method} ${url.pathname}`);
};
function View(){const controller=useDevelopmentExecution({sourceId:id(1),taskId:id(2)});return <main className="dx-production-ui"><div className="pattern-orders digital-production"><Surface>{mode==='fixed'?<DevelopmentAssignmentTable controller={controller} editing/>:mode==='external'||mode==='readonly'||mode==='request'?<DevelopmentExternalPattern controller={controller}/>:mode==='revision'?<DigitalDevelopmentPanel sourceId={id(1)} onClose={()=>undefined} embedded/>:<TaskWorkbenchSample task={task as DigitalTask} onClose={()=>undefined}/>} {controller.writeError&&<p role="alert">{controller.writeError}</p>}</Surface></div></main>;}
createRoot(window.document.getElementById('root')!).render(<View/>);
