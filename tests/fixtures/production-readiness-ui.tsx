import {bulkPatternFixtureResponse} from "./bulk-pattern-card-response.js";
// Actual existing components; test-only HTTP fault injection, not live application acceptance.
import {BulkPatternWorkspace} from '../../apps/web/src/bulk-pattern-workspace.js';
import {createRoot} from 'react-dom/client';
import {canLeaveInternalPage} from '../../apps/web/src/internal-navigation.js';
import {BulkPreparationPanel} from '../../apps/web/src/bulk-preparation-panel.js';
import {ProductionInstructionPanel} from '../../apps/web/src/production-instruction-panel.js';
import '../../packages/ui/src/tokens.css';
import '../../packages/ui/src/components.css';
import '../../apps/web/src/styles.css';
const input=structuredClone(Reflect.get(window,'preparationInput'));
const mode=new URLSearchParams(location.search).get('mode')??'normal';
input.bulk.reference.styleImageUrl=null;
for(const fact of input.readiness.history)fact.note+=' · 长物料说明'.repeat(20);
const fabric=input.readiness.facts.find((f:{kind:string})=>f.kind==='fabric_receipt');if(fabric)fabric.quantities=[{lineId:null,materialId:'00000000-0000-4000-8000-000000000011',name:'TEST主布',quantity:100,unit:'米'},{lineId:null,materialId:'00000000-0000-4000-8000-000000000012',name:'TEST配布',quantity:20,unit:'米'}];
Reflect.set(window,'preparationCanLeave',canLeaveInternalPage);
input.bulk.readiness=input.readiness;input.instruction.readiness=input.readiness;
if(mode==='supplement'){const task=input.bulk.tasks.find((t:{taskKind:string})=>t.taskKind==='bulk_pattern');task.dueAt=null;task.enteredAt='2026-11-10T00:00:00Z';}
if(mode==='empty'){input.readiness.facts=[];input.readiness.history=[];for(const kind of ['draftWindow','finalWindow'])input.readiness[kind]={startedAt:null,dueAt:null,completedAt:null,minutes:null,reason:'TEST尚无实际发生记录',status:'waiting'};}
if(mode.startsWith('label-')){
 const labels=input.readiness.facts.find((f:{kind:string})=>f.kind==='style_label_ready'),black=input.readiness.lines.find((l:{color:string})=>l.color==='黑');
 labels.quantities=[{lineId:black.lineId,materialId:null,name:'TEST黑PO款号唛',quantity:black.orderQuantity,unit:'枚'}];
 Reflect.set(window,'preparationOriginalLabels',structuredClone(labels.quantities));
}
if(mode==='range-version'||mode==='range-conflict'){
 const own=input.readiness.ranges.filter((r:{preparationId:string})=>r.preparationId===input.bulk.preparationId),paper=own.filter((r:{kind:string})=>r.kind==='纸样完成').sort((a:{version:number},b:{version:number})=>b.version-a.version);
 input.readiness.ranges=[...paper,...own.filter((r:{kind:string})=>r.kind==='唛架完成'),{...paper[0],rangeId:'00000000-0000-4000-8000-000000000998',preparationId:'00000000-0000-4000-8000-000000000999',version:99,note:'TEST前版范围，不参与本次版本'}];
 input.bulk.readiness=input.readiness;
}
const requests:Array<{path:string;key:string;body:unknown}>=[],cache=new Map();let writes=0,uncertain=false,refreshFailure=false,initialReadFailed=false;
Reflect.set(window,'preparationRequests',requests);Reflect.set(window,'preparationWrites',()=>writes);
window.fetch=async(path,init)=>{
 const url=String(path),method=init?.method??'GET',payload=init?.body?JSON.parse(String(init.body)):null;
 if(url.includes('/access/candidates'))return Response.json(input.people);
 if(url.includes('/workspaces/bulk-pattern'))return Response.json(bulkPatternFixtureResponse({page:1,pageSize:15,total:1,items:[{orderId:input.bulk.orderId,designStyleNo:input.bulk.reference.designStyleNo,customer:'TEST',sheet:input.bulk}]},new URL(url,location.href).searchParams));
 if(method!=='GET'){
  const headers=new Headers(init?.headers),key=headers.get('Idempotency-Key')??'';requests.push({path:url,key,body:payload});
  if(['conflict','label-conflict','range-conflict'].includes(mode))return Response.json({error:{code:'PREPARATION_CONFLICT',message:'TEST资料已更新，请刷新；原输入保留'}},{status:409});
  if(!cache.has(key)){
   if(url.includes('/bulk-preparation')&&payload.range){const version=Math.max(0,...input.readiness.ranges.filter((r:{preparationId:string;kind:string})=>r.preparationId===payload.preparationId&&r.kind===payload.kind).map((r:{version:number})=>r.version));if(version!==payload.range.expectedVersion)return Response.json({error:{code:'BULK_PREPARATION_CONFLICT',message:'TEST准备范围已更新，请刷新'}},{status:409});}
   writes++;let result;
   if(url.includes('/production-readiness')){result=structuredClone(input.readiness);if(url.includes('/responsibility'))result.responsibility={version:payload.expectedVersion+1,warehouseWorkerId:payload.warehouseWorkerId,colorConfirmationWorkerId:payload.colorConfirmationWorkerId,colorConfirmationRole:payload.colorConfirmationRole};if(url.includes('/instruction-deliveries'))result.instructionDeliveries.push({eventId:'TEST delivery',...payload});if(payload.kind){const prior=result.facts.find((f:{kind:string})=>f.kind===payload.kind);const fact={...prior,...payload,version:payload.expectedVersion+1,recordId:prior?.recordId??'00000000-0000-4000-8000-000000000009',recordedAt:'2026-11-10T00:00:00Z',recordedBy:'TEST',operatorName:'TEST仓管',valid:true,invalidReasons:[],resource:result.resource};result.facts=result.facts.filter((f:{kind:string})=>f.kind!==payload.kind).concat(fact);result.history.push(fact);}input.readiness=result;input.bulk.readiness=result;}
   else if(url.includes('/bulk-preparation')){if(payload.range){input.readiness.ranges.push({rangeId:'TEST range '+writes,preparationId:payload.preparationId,kind:payload.kind,version:payload.range.expectedVersion+1,lineIds:payload.range.lineIds,complete:payload.range.complete,pendingMaterialIds:payload.range.pendingMaterialIds,note:payload.range.note,recordedAt:'2026-11-10T00:00:00Z',evidenceIds:payload.range.evidenceIds??[],basis:{}});input.bulk.readiness=input.readiness;}result=structuredClone(input.bulk);}
   else result=input.instruction;
   cache.set(key,result);
  }
  Reflect.set(window,'preparationWriteCount',writes);
  if((mode==='uncertain'||mode==='parent-range-uncertain')&&!uncertain){uncertain=true;return Response.json({error:{code:'TEST_FAILURE',message:'TEST响应丢失，结果待核'}},{status:503});}
  if(mode==='parent-writing')await new Promise<void>(resolve=>Reflect.set(window,'resolvePreparationWrite',resolve));
  if(mode==='refreshfail')refreshFailure=true;
  return Response.json(cache.get(key));
 }
 if(url.includes('/production-readiness')){if(mode==='loadfail'&&!initialReadFailed){initialReadFailed=true;return Response.json({error:{code:'TEST_INITIAL_READ_FAILURE',message:'TEST初次读取失败，原资料未变'}},{status:503});}return Response.json(input.readiness);}
 if(url.includes('/bulk-preparation')){if(refreshFailure){refreshFailure=false;return Response.json({error:{code:'TEST_READ_FAILURE',message:'TEST保存成功后刷新失败'}},{status:503});}return Response.json(input.bulk);}
 if(url.includes('/instruction'))return Response.json(input.instruction);
 return Response.json({message:'TEST未配置的读取入口'},{status:404});
};
createRoot(document.getElementById('root')!).render(<main className="pattern-golden" style={{maxWidth:1400,margin:'0 auto',padding:16}}><p>隔离回归：原有页面组件与测试数据</p>{mode.startsWith('parent-')?<BulkPatternWorkspace orderId={input.bulk.orderId} canViewAll={true}/>:mode==='instruction'?<ProductionInstructionPanel orderId={input.bulk.orderId} onClose={()=>undefined}/>:<BulkPreparationPanel orderId={input.bulk.orderId} onClose={()=>undefined} readonly={mode==='readonly'}/>}</main>);
