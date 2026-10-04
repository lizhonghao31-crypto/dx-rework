import assert from 'node:assert/strict';
import {chromium} from 'playwright';
// Real App with synthetic, read-only responses. Never use a live session or database.
const base=new URL(process.env.DIGITAL_QUERY_TEST_URL||'http://127.0.0.1:3207');
assert(['127.0.0.1','localhost'].includes(base.hostname));
const id='11111111-1111-4111-8111-111111111111';
const browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{})});
try{
 const page=await browser.newPage();page.setDefaultTimeout(10000);
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>sessionStorage.setItem('dx-rework:platform-module','rework'));
 const task={taskId:id,taskKind:'bulk_qc',label:'大货质检',state:'pending',assigneeName:'隔离QC'};
 const history=[{checkId:'old-blue',lineId:'blue',returnFactId:'first-return',result:'合格',problem:'',treatment:'',attachmentIds:[],checkedBy:'隔离QC',checkedAt:'2026-10-04T04:20:00Z'},
  {checkId:'old-green',lineId:'green',returnFactId:'first-return',result:'需处理',problem:'历史绿PO印花问题',treatment:'退回修复',attachmentIds:[],checkedBy:'隔离QC',checkedAt:'2026-10-04T04:20:00Z'}];
 const sheet={orderId:id,revision:1,secondaryCraft:'印花',allCut:true,allQc:false,inTransit:true,dispatched:false,reasons:[],supplierName:'隔离加工厂',productionId:null,sampleTargetDate:null,
  canManage:false,canLogistics:false,canQc:true,canWarehouse:false,canFollowup:false,tasks:[task],
  lines:['blue','green'].map((lineId,i)=>({lineId,poNumber:`PO-${i+1}`,color:i?'绿':'蓝',result:null,problem:'',treatment:''})),facts:[],checks:[]};
 const closure={orderId:id,stage:'本期装箱完成',shipmentStatus:'未知',customerReceiptStatus:'未知',canOpenReceiving:false,canOpenRework:true,canOpenWages:true,canClose:false,closed:null,outstanding:[],lines:[{
  lineId:'blue',poNumber:'PO-1',color:'蓝',orderedQuantity:100,actualQuantity:100,documentQuantity:100,defectiveQuantity:0,receiptCount:1,packingQuantity:100,receipts:[],reworks:[{reworkId:id,reworkNo:'TEST-LOCAL-DUAL',status:'completed',problem:'原质量问题',quantity:null,wageItemCount:2}]}]};
 await page.route('**/api/**',async route=>{
  assert.equal(route.request().method(),'GET','No business write is permitted');
  const path=new URL(route.request().url()).pathname.split('/api/')[1];let body={};
  if(path==='auth/me')body={status:'authorized',user:{id,displayName:'隔离QC',businessRoles:['quality_control'],capabilities:[]}};
  else if(path===`digital-production/orders/${id}/factory-flow`)body=sheet;
  else if(path===`digital-production/orders/${id}/closure`)body=closure;
  else if(path==='digital-production/options')body={creationEnabled:false,customers:[]};
  else if(path==='digital-production/access/options')body={roles:['quality_control'],actorId:id};
  else if(path==='digital-production/orders'||path==='digital-production/sources')body={items:[]};
  else if(path?.startsWith('digital-production/notifications/'))body={notification:null};
  await route.fulfill({json:body});
 });
 await page.goto(new URL(`/ui/digital-production?factory=${id}`,base).href);
 const verify=async(label,disabled)=>{
  await page.getByRole('heading',{name:`大货质检 · ${label}`,exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'保存检查／复查',exact:true}).isDisabled(),disabled);
  assert.equal(await page.locator('select[name="result:blue"]').isDisabled(),disabled);
 };
 const refresh=async()=>{await page.getByRole('button',{name:'刷新',exact:true}).click();};
 await verify('未就绪',true);
 task.state='ready';sheet.inTransit=false;sheet.checks=history;await refresh();await verify('可办理',false);
 sheet.inTransit=true;sheet.revision++;await refresh();await verify('等待整款工艺回仓',true);
 await page.getByText('历史绿PO印花问题 退回修复',{exact:true}).waitFor();
 sheet.facts=[{factId:'partial',kind:'工艺沟通',actorName:'隔离跟单',occurredAt:null,payload:{note:'蓝PO部分回仓，绿PO仍在途'}}];
 await refresh();await page.getByText(/蓝PO部分回仓，绿PO仍在途/).waitFor();await verify('等待整款工艺回仓',true);
 sheet.inTransit=false;sheet.revision++;await refresh();await verify('可办理',false);
 assert.equal(await page.getByRole('heading',{name:/当前未检查/}).count(),2);
 sheet.lines[0].result='合格';await refresh();await verify('可办理',false);
 await page.getByText('历史绿PO印花问题 退回修复',{exact:true}).waitFor();
 for(const [state,label] of [['blocked','阻断'],['completed','已完成'],['cancelled','已取消']]){
  task.state=state;sheet.inTransit=true;await refresh();await verify(label,true);
 }
 sheet.canQc=false;task.state='ready';await refresh();await page.getByRole('heading',{name:'大货质检 · 等待整款工艺回仓',exact:true}).waitFor();
 assert.equal(await page.getByRole('button',{name:'保存检查／复查',exact:true}).count(),0);
 await page.goto(new URL(`/ui/digital-production?closure=${id}`,base).href);
 await page.getByText(/原状态 已完成 · 原单未记录返工数量/).waitFor();
 assert.equal(await page.getByText(/待填写/).count(),0);
 await page.getByText('原工资台账关联 2 条',{exact:true}).waitFor();
 await page.getByText('当前未见未清事项。',{exact:true}).waitFor();
 await page.getByText(/出柜：未知 · 客户签收：未知/).waitFor();
 for(const quantity of [0,3]){
  closure.lines[0].reworks[0].quantity=quantity;
  await page.getByRole('button',{name:'刷新原实绩',exact:true}).click();
  await page.getByText(new RegExp(`原状态 已完成 · 返工 ${quantity} 件`)).waitFor();
 }
 assert.deepEqual(errors,[]);
 console.log('PASS: first/second/partial/whole return, partial QC, unchanged history, blocked/completed/cancelled and read-only gates; nullable original quantity, 0 and 3, wage references and shipment unknown preserved. No writes.');
}finally{await browser.close();}
