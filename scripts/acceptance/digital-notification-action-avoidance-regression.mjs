import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
// Actual App/IE component, synthetic API only; no live session or approval writes.
const base=new URL(process.env.DIGITAL_QUERY_TEST_URL||'http://127.0.0.1:3206');
assert(['127.0.0.1','localhost'].includes(base.hostname));
const evidence=resolve(process.env.DIGITAL_NOTIFICATION_EVIDENCE_DIR||'/tmp/dx-toast-action-evidence');
await mkdir(evidence,{recursive:true});
const id='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
const browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{})});
try {
 const page=await browser.newPage({viewport:{width:1165,height:747}});let notice=true,title="隔离返工单待办理通知",claims=0,acknowledgements=0;
 await page.addInitScript(()=>sessionStorage.setItem('dx-rework:platform-module','rework'));
 const items=Array.from({length:12},(_,i)=>({configurationItemId:`33333333-3333-4333-8333-${String(i+1).padStart(12,'0')}`,source:'custom',processId:null,processVersion:null,processName:`隔离工序 ${i+1}`,executionKind:'worker',pricingUnit:'piece',plannedQuantity:100,unitPrice:0.1,promotedProcessId:null}));
 await page.route('**/api/**',async route=>{
  const path=new URL(route.request().url()).pathname.split('/api/')[1];let body={};
  if(path==='auth/me')body={status:'authorized',user:{id,displayName:'隔离 IE',capabilities:['process:review','todo:view'],businessRoles:['ie_reviewer']}};
  else if(path==='todos/mine/indicator')body={pendingCount:1};
  else if(path?.startsWith('digital-production/notifications/')){
   if(path.endsWith('/acknowledge')){assert.equal(route.request().method(),'POST');acknowledgements++;notice=false;}
   else {if(path.endsWith('/claim'))claims++;body={notification:notice?{eventId:id,title,actionable:true,route:{routeName:'digital_development',entityId:id,todoId:id},createdAt:'2026-10-04T00:00:00Z'}:null};}
  }else{
   assert.equal(route.request().method(),'GET');
   if(path?.endsWith('/process-configuration'))body={reworkOrderId:id,reworkNo:'TEST-LOCAL-TOAST',reworkStatus:'pending_ie_review',orderVersion:1,tailInspectionRequired:false,configuration:{configurationId:other,configurationVersion:1,kind:'initial',status:'pending_ie_review',changeReason:null,reviewReason:null,createdAt:'2026-10-04T00:00:00Z',submittedAt:'2026-10-04T00:00:00Z',reviewedAt:null,unifiedExecutionRequired:true,items}};
   else if(path?.endsWith('/process-worker-plan'))body={reworkOrderId:id,reworkStatus:'pending_ie_review',orderVersion:1,required:true,configurationId:other,configurationVersion:1,configurationStatus:'pending_ie_review',assignments:items.map(item=>({configurationItemId:item.configurationItemId,processName:item.processName,executionKind:'worker',members:[{personId:other,displayName:'隔离工人',personType:'internal'}]})),complete:true};
   else if(path?.endsWith('/business-detail'))body={reworkOrderId:id,createdBy:{userId:other,displayName:'隔离发起人'},processConfigurationCreatedBy:{userId:other,displayName:'隔离主管'}};
  }
  await route.fulfill({json:body,headers:{'x-dx-rework-actor-id':id}});
 });
 await page.goto(new URL(`/ui/process-configuration?rework=${id}`,base).href);
 const button=page.getByRole('button',{name:'核价通过',exact:true});await button.waitFor();
 const toast=page.getByRole('region',{name:'站内提醒'});await toast.waitFor();
 const ready=async()=>{
  await page.evaluate(()=>window.scrollTo(0,document.documentElement.scrollHeight));
  await page.waitForFunction(()=>{
   const button=[...document.querySelectorAll('button')].find(el=>el.textContent==='核价通过');if(!button)return false;
   const r=button.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
   return hit===button||button.contains(hit);
  });
  await button.click({trial:true,timeout:1500});
 };
 const initialClaims=claims;
 for(const [width,height] of [[1165,747],[1280,800],[1440,1024],[900,600],[801,568],[390,844],[320,568]]){
  await page.setViewportSize({width,height});await ready();
  const b=await button.boundingBox(),t=await toast.boundingBox();
  assert(t&&t.width<=300&&t.x>=0&&t.y>=0&&t.x+t.width<=width&&t.y+t.height<=height);
  if(width>800){assert(Math.abs(width-t.x-t.width-16)<=1);assert(t.y+t.height<=b.y-7);}
  assert.equal(acknowledgements,0);assert.equal(claims,initialClaims);
  await page.screenshot({path:resolve(evidence,`${width}x${height}.png`)});
  console.log(JSON.stringify({width,height,button:b,toast:t}));
 }
 await page.setViewportSize({width:1165,height:747});
 title='长通知'.repeat(40)+'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.repeat(3);
 await page.evaluate(()=>window.dispatchEvent(new Event('dx-rework:todo-refresh')));
 await toast.locator('p').first().filter({hasText:'长通知'}).waitFor();await ready();
 const long=await toast.boundingBox();assert(long.height<=747*0.4+1);
 const close=await toast.getByRole('button',{name:'我知道了',exact:true}).boundingBox();
 assert(close&&close.y>=long.y&&close.y+close.height<=long.y+long.height);
 await page.screenshot({path:resolve(evidence,'long-message.png')});
 // Returning to a page position with no intersecting actions restores the default corner.
 await page.evaluate(()=>window.scrollTo(0,0));
 await page.waitForFunction(()=>{const r=document.querySelector('.digital-notification-toast').getBoundingClientRect();return Math.abs(innerHeight-r.bottom-16)<=1;});
 await page.evaluate(()=>{for(let i=0;i<20;i++)window.dispatchEvent(new Event('dx-rework:todo-refresh'));});
 assert.equal(acknowledgements,0);assert.equal(claims,initialClaims);
 await ready();
 await toast.getByRole('button',{name:'我知道了',exact:true}).focus();await page.keyboard.press('Enter');
 await toast.waitFor({state:'hidden'});assert.equal(acknowledgements,1);
 await button.click({trial:true,timeout:1500});
 console.log('PASS: actual IE approval remains clickable with visible notice in seven viewports, long message and scroll/resize; compact right placement and default restoration; movement causes no acknowledgement or hidden claim; keyboard acknowledgement still works; no approval submitted.');
}finally{await browser.close();}
