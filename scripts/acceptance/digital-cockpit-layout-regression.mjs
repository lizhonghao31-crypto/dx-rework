import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
const base=new URL(process.env.DIGITAL_QUERY_TEST_URL||'http://127.0.0.1:3206');
assert(['localhost','127.0.0.1'].includes(base.hostname));
const output=process.env.DIGITAL_COCKPIT_EVIDENCE_DIR||'/tmp/dx-a4-cockpit-evidence';await mkdir(output,{recursive:true});
const id='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
const task={taskId:id,sourceId:id,orderId:null,taskKind:'development_sewing',label:'开发车板',routeVersion:1,occurrence:1,state:'ready',assigneeName:'TEST工人',assigneeId:other,requiredRole:'pattern_room_worker',enteredAt:'2026-10-04T00:00:00Z',completedAt:null,recordedAt:'2026-10-04T00:00:00Z',dueAt:null,warningAt:null,slaHours:null,policyVersion:1,timeQuality:'现场登记',blockedReason:null,paused:false,routeProgress:{applicable:7,completed:2,cancelled:0},canManage:true,canControl:true,canCorrect:true,canExecute:false};
const row=(key,designer)=>({id:key,sourceId:key,orderId:key,styleNo:`TEST-${designer}`,customer:'PD',category:'男装',designer,merchandiser:'TEST跟单',deliveryDate:'2026-11-01',createdAt:'2026-10-04T00:00:00Z',tasks:[{...task,taskId:key}],progress:{applicable:7,completed:2},lines:[{id,po:'TEST-PO-1',color:'黑',quantity:100},{id:other,po:'TEST-PO-2',color:'白',quantity:50}]});
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium'});
try{const page=await browser.newPage();let saves=0;
await page.route('**/api/**',async route=>{const path=new URL(route.request().url()).pathname.split('/api/')[1];let body={};
if(path==='auth/me')body={status:'authorized',user:{id,displayName:'TEST真实主管',businessRoles:['pattern_room_supervisor'],capabilities:[]}};
else if(path==='digital-production/cockpit')body={actorId:id,actorName:'TEST真实主管',canViewTodos:false,canManagePolicies:true,total:2,page:1,summary:{active:2,blocked:0,overdue:0,dueSoon:0,unknown:0},items:[row(id,'设计甲'),row(other,'设计乙')]};
else if(path==='digital-production/deadline-policies')body=[{nodeKey:'development_sewing',label:'开发车板',slaHours:24,warningRatio:0.8,version:1,changedAt:'2026-10-04T00:00:00Z',changedBy:'TEST老板',note:''}];
else if(path==='digital-production/deadline-policies/development_sewing'){assert.equal(route.request().method(),'PUT');saves++;body={};}
else assert.equal(route.request().method(),'GET');
await route.fulfill({json:body});});
await page.goto(new URL('/ui/digital-cockpit',base).href);await page.getByRole('heading',{name:'生产管理座舱'}).waitFor();
await page.getByRole('button',{name:'TEST-设计乙',exact:true}).click();assert(await page.getByText('TEST真实主管',{exact:true}).isVisible());
await page.getByText('展开 PO 与款色',{exact:true}).click();assert(await page.getByText('TEST-PO-2 · 白 · 50 件',{exact:true}).isVisible());
for(const [width,height] of [[1536,960],[390,844]]){await page.setViewportSize({width,height});await page.getByRole('button',{name:'TEST-设计乙',exact:true}).waitFor();await page.screenshot({path:`${output}/${width}x${height}.png`,fullPage:true});await page.getByRole('button',{name:'工序时效设定',exact:true}).click();const dialog=page.getByRole('dialog',{name:'工序时效设定'});await dialog.waitFor();const box=await dialog.boundingBox();assert(box.x>=0&&box.y>=0&&box.x+box.width<=width&&box.y+box.height<=height);await dialog.getByRole('button',{name:'应用到未完成任务'}).click();await dialog.getByRole('button',{name:'关闭',exact:true}).click();}
assert.equal(saves,2);console.log('PASS: actual cockpit component, stable login identity, two PO expansion, no-SLA display, desktop/mobile screenshots and reachable policy save; synthetic API fixture, no Acceptance claim.');
}finally{await browser.close();}
