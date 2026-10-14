import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {chromium} from 'playwright';
// Real application with synthetic API responses only; no live business data.
const base=new URL(process.env.UAT_MATERIAL_TEST_URL||'http://127.0.0.1:3219');
assert(['127.0.0.1','localhost'].includes(base.hostname),'Only a local frontend is permitted');
const evidence=process.env.UAT_MATERIAL_EVIDENCE||'/tmp/uat-material-browser';
const source='11111111-1111-4111-8111-111111111111',id='22222222-2222-4222-8222-222222222222';
const browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{})});
await mkdir(evidence,{recursive:true});
try{
for(const role of ['development_clerk','root_superuser']){
 const page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[];let failed=true,writes=0,complete=false;
 page.on('pageerror',e=>errors.push(e.stack));page.setDefaultTimeout(15000);
 await page.addInitScript(()=>sessionStorage.setItem('dx-rework:platform-module','rework'));
 const material=(materialId,category,label)=>({materialId,category,label,name:label,specification:'测试规格',quantity:'1',requiredThisRound:true,available:true});
 const materials=[material('main','主布','棉布'),material('secondary','配布','罗纹'),material('accessory','辅料','拉链')];
 const task=()=>({taskId:id,sourceId:source,orderId:null,taskKind:'development_materials',label:'开发核配委派',state:complete?'completed':'ready',routeVersion:1,occurrence:1,identity:{designStyleNo:'TEST 核料',customerCode:'TEST'},assigneeId:source,assigneeName:'隔离文员',requiredRole:'development_clerk',enteredAt:'2026-10-14T00:00:00Z',dueAt:null,warningAt:null,slaHours:4,timeQuality:'现场登记',routeProgress:{completed:complete?1:0,applicable:3,cancelled:0},canExecute:true,canManage:role==='root_superuser',canControl:role==='root_superuser',canCorrect:role==='root_superuser',hasHandover:false});
 const sheet={sourceId:source,status:'published',version:1,roundNumber:1,latestRoundNumber:1,designStyleNo:'TEST 核料',customerCode:'TEST',developmentType:'头版',designerName:'隔离设计师',canEdit:role==='root_superuser',materialEvents:[],document:{materials,files:[],quantity:1,sampleSize:'M',sizes:['M'],measurements:[],instructions:'隔离核料场景',craft:'无',washing:'免洗'}};
 await page.route('**/api/**',async route=>{
  const path=new URL(route.request().url()).pathname.split('/api/')[1];let body={};
  if(route.request().method()!=='GET'){
   assert.equal(path,`digital-production/sources/${source}/execution/check`);writes++;
   const payload=route.request().postDataJSON();assert.equal(payload.note,'保留此备注');assert.equal(payload.items.length,2);
   await new Promise(r=>setTimeout(r,200));
   if(failed){failed=false;return route.fulfill({status:409,json:{error:{message:'隔离校验失败：请核实配布'}}});}
   complete=true;return route.fulfill({json:{taskId:id,result:'通过'}});
  }
  if(path==='auth/me')body={status:'authorized',user:{id:source,displayName:'隔离用户',capabilities:[],businessRoles:[role],isRoot:role==='root_superuser'}};
  else if(path==='digital-production/access/options')body={roles:[role],actorId:source,manage:role==='root_superuser'};
  else if(path==='digital-production/options')body={creationEnabled:false,customers:[]};
  else if(path==='digital-production/access/candidates')throw Error('Material check must not request assignment candidates');
  else if(path==='digital-production/workspaces/pattern')body={items:[],owners:[],risks:[],counts:Object.fromEntries(['materials','pattern','cutting','craft','sewing','check','shipping'].map(k=>[k,0])),total:0,archiveTotal:1,asOf:'2026-10-14T00:00:00Z'};
  else if(path===`digital-production/tasks/${id}`)body=task();
  else if(path===`digital-production/tasks/${id}/history`)body={events:[],revisions:[]};
  else if(path===`digital-production/sources/${source}/development`)body=sheet;
  else if(path===`digital-production/sources/${source}/execution`)body={sheet,dispatch:null,tasks:[task()],facts:[],routeFacts:[],patternOrder:{orderId:source},patternPreparation:{status:'draft',categorySaved:true,priceSaved:true,workerName:null},canDispatch:true,canReportFabric:true,canDecideFabric:true};
  else if(['digital-production/tasks','digital-production/orders','digital-production/sources'].includes(path))body={items:[]};
  return route.fulfill({json:body});
 });
 await page.goto(new URL(`/ui/digital-pattern-room?task=${id}`,base).href,{waitUntil:'networkidle'});
 try{await page.getByRole('heading',{name:'核料办理',exact:true}).waitFor();}catch(e){console.log('DIAGNOSTIC',errors,await page.locator('body').innerText());throw e;}
 assert.equal(await page.getByText('预派人员（纸样、裁板、车板）',{exact:true}).count(),0);
 assert.equal(await page.locator('.pattern-supervisor-assignment').count(),0);
 assert.equal(await page.getByText('原执行品类 / 价格快照：',{exact:false}).count(),0);
 await page.getByRole('rowheader',{name:/辅料.*拉链/}).first().waitFor();
 const form=page.locator('form').filter({has:page.getByRole('button',{name:'提交面辅料核对结果',exact:true})});
 for(const checkbox of await form.locator('input[type=checkbox]').all())await checkbox.check();
 await form.locator('textarea[name=note]').fill('保留此备注');
 await form.getByRole('button',{name:'提交面辅料核对结果'}).click();
 await form.getByRole('alert').waitFor();
 assert.equal(await form.locator('textarea[name=note]').inputValue(),'保留此备注');
 assert.equal(await form.locator('input:checked').count(),8);
 await page.screenshot({path:`${evidence}/${role}-failure.png`,fullPage:true});
 await form.getByRole('button',{name:'提交面辅料核对结果'}).click();
 await page.waitForFunction(()=>!document.querySelector('textarea[name=note]'));
 assert.equal(writes,2);assert.deepEqual(errors,[]);
 console.log('PASS',role,'isolated material form, fixed categories/accessories, retained inputs, successful refresh');
 await page.close();
}
}finally{await browser.close();}
