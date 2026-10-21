// Actual pages with synthetic TEST responses. No real identity sync, Acceptance control or deployment.
import '../../apps/web/src/App.js';
import {createRoot} from 'react-dom/client';
import {Shell} from '../../apps/web/src/components.js';
import {AuthGate} from '../../apps/web/src/auth.js';
import {EmployeeAccessPage} from '../../apps/web/src/employee-access-page.js';
import {WorkforceMasterDataPage} from '../../apps/web/src/workforce-master-data-page.js';
import {PatternRoomPricesPage} from '../../apps/web/src/pattern-room-prices-page.js';
import {ContractTemplateSettingsPage} from '../../apps/web/src/contract-template-settings-page.js';
import {AdminConsolePage} from '../../apps/web/src/admin-console-page.js';
import {AcceptanceLabPage} from '../../apps/web/src/acceptance-lab-page.js';
import {AcceptanceProductionCommandCenterPage} from '../../apps/web/src/acceptance-production-command-center-page.js';
import {CONTRACT_TERM_LABELS} from '@dx-rework/contracts';
import '@dx-rework/ui/tokens.css';import '@dx-rework/ui/components.css';import '../../apps/web/src/styles.css';
import '../../apps/web/src/workflow-shell.css';import '../../apps/web/src/dialog-visual-system.css';import '../../apps/web/src/workflow-state-visual.css';import '../../apps/web/src/ui-polish.css';
const params=new URLSearchParams(location.search),view=params.get('view')??'auth',mode=params.get('mode')??'503',id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,now='2026-10-20T00:00:00.000Z';
const root={status:'authorized',user:{id:id(1),displayName:'TEST Root',businessRoles:['root_superuser'],capabilities:['access:admin','admin:read'],isRoot:true}};
const employee={userId:id(2),providerUserId:'TEST-employee',displayName:'TEST员工',departments:['TEST'],active:true,employed:true,enabled:true,manualAccessDisabled:false,lastVerifiedAt:now,hasLoggedIn:true,isRoot:false,businessRoles:['pattern_room_worker'],roleHistory:[{assignmentId:id(3),roleCode:'pattern_room_worker',grantedAt:now,grantedBy:id(1),grantReason:'TEST',revokedAt:null,revokedBy:null,revokeReason:null}]};
const price={priceId:id(4),kind:'category',name:'TEST打板类别',unit:'件',amount:'10.000',enabled:true,version:1,updatedBy:'TEST Root',updatedAt:now};
const prices={categories:[price],hourly:{...price,priceId:id(5),kind:'hourly',name:'TEST小时价',unit:'小时'},canWriteCategories:true,canWriteHourly:false};
let template={item:{templateName:'TEST原模板',partyAName:'TEST甲方',partyAAddress:'TEST地址',signingPlace:'TEST地点',terms:Object.fromEntries(Object.keys(CONTRACT_TERM_LABELS).map(key=>[key,key==='processingResponsibility'?'TEST {{工艺}}':'TEST条款'])),templateVersion:1,createdAt:now},history:[] as unknown[]};
const requests:Array<{path:string;method:string;body:unknown;key:string|null}>=[],commands=new Map<string,unknown>();let authReads=0,directoryReads=0,controlReads=0,failOnce=false,commits=0;
const originalClock=Date.now.bind(Date);let offset=0;Date.now=()=>originalClock()+offset;
Object.assign(window,{platformFeedbackFixture:{requests,get commits(){return commits;},advance:()=>{offset+=24*3600*1000;}}});
window.fetch=async(input,init)=>{
 await new Promise(resolve=>setTimeout(resolve,0));const url=new URL(String(input),location.origin),path=url.pathname,method=init?.method??'GET',body=init?.body?JSON.parse(String(init.body)):null,key=new Headers(init?.headers).get('idempotency-key');requests.push({path,method,body,key});
 const reject=(status:number,message='TEST读取未完成，请重试读取')=>Response.json({error:{code:status===403?'FORBIDDEN':'TEST_UNAVAILABLE',message,requestId:'TEST-request'}},{status});
 if(path.endsWith('/auth/me')){authReads++;if(view==='auth'){
  if(mode==='401')return reject(401,'TEST请登录');if(mode==='no-role')return Response.json({...root,status:'no_role',user:{...root.user,isRoot:false,businessRoles:[]}});
  if(authReads===1){if(mode==='network')throw new TypeError('TEST network unavailable');if(mode==='malformed')return Response.json({status:'authorized',user:null});return reject(503);}
 }return Response.json(root);}
 if(path.endsWith('/access/me'))return Response.json({userId:id(1),displayName:'TEST Root',isRoot:true});
 if(path.endsWith('/access/roles'))return Response.json([{roleCode:'pattern_room_worker',displayName:'TEST板房工人',description:'TEST',capabilities:[]}]);
 if(path.includes('/employee-access/employees')&&method==='GET'){
  directoryReads++;if(mode==='fail'&&directoryReads===1||mode==='saved-read-fail'&&commits===1&&!failOnce){failOnce=true;return reject(503);}
  return Response.json({lastDirectorySyncedAt:null,employees:mode==='empty'?[]:[employee]});
 }
 if(path.includes('/master-data/people')&&method==='GET'){directoryReads++;if(mode==='fail'&&directoryReads===1)return reject(503);return Response.json([]);}
 if(path.endsWith('/pattern-room/prices')&&method==='GET')return Response.json(prices);
 if(path.includes('/pattern-room/prices/')&&path.endsWith('/history'))return Response.json([]);
 if(path.endsWith('/sourcing/contract-template')&&method==='GET')return Response.json(template);
 if(path.endsWith('/sourcing/contract-template/preview'))return new Response('%PDF-1.4\nTEST preview\n%%EOF',{headers:{'content-type':'application/pdf'}});
 if(path.endsWith('/acceptance/control/status')){controlReads++;if(mode==='network'&&controlReads===1)throw new TypeError('TEST network');if(mode==='fail'&&controlReads===1)return reject(503);return reject(401,'TEST控制凭证待提供');}
 if(path.endsWith('/admin/audit/events')){directoryReads++;if(mode==='fail'&&directoryReads===1)return reject(503);return Response.json(mode==='malformed'&&directoryReads===1?{items:null}:{items:[],page:1,pageSize:15,totalCount:0,totalPages:1});}
 if(path.endsWith('/admin/audit/exports'))return Response.json({items:[],nextCursor:null});
 if(method!=='GET'){
  if(path.includes('/acceptance/')||path.includes('/directory/sync'))return reject(403,'TEST此验收禁止控制／同步写入');
  if(mode==='denied')return reject(403,'TEST原有权岗位才可办理，请核对原权限');
  const scope=path+':'+key;if(commands.has(scope))return Response.json(commands.get(scope));
  let reply:unknown;
  if(path.endsWith('/disable')){commits++;employee.enabled=false;employee.manualAccessDisabled=true;if(mode==='lost')throw new TypeError('TEST receipt lost');return new Response(null,{status:204});}
  if(path.includes('/pattern-room/prices/')){commits++;Object.assign(price,{amount:body.amount,enabled:body.enabled,version:price.version+1});reply={...price};}
  else if(path.endsWith('/sourcing/contract-template')){commits++;const {expectedVersion,...content}=body;template={item:{...content,templateVersion:expectedVersion+1,createdAt:now},history:[template.item,...template.history]};reply=template;}
  else return reject(403,'TEST写入未映射');
  commands.set(scope,reply);if(!failOnce){failOnce=true;if(mode==='malformed')return Response.json({});throw new TypeError('TEST committed but response lost');}return Response.json(reply);
 }
 return reject(404,'TEST未映射的只读请求');
};
const content=view==='auth'?<AuthGate requiredRole="root_superuser"><p>TEST受保护业务</p></AuthGate>:view==='employee'?<EmployeeAccessPage/>:view==='workforce'?<WorkforceMasterDataPage/>:view==='prices'?<PatternRoomPricesPage/>:view==='template'?<ContractTemplateSettingsPage/>:view==='admin'?<AdminConsolePage/>:view==='acceptance'?<AcceptanceLabPage/>:<AcceptanceProductionCommandCenterPage/>;
const page=['prices','template','admin'].includes(view)?<Shell active={view==='prices'?'价格管控':view==='template'?'合同模板设置':'系统管理'}>{content}</Shell>:content;
createRoot(document.getElementById('root')!).render(page);
