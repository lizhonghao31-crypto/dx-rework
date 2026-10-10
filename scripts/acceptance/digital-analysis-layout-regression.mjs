import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
const base=new URL(process.env.DIGITAL_ANALYSIS_TEST_URL||'http://127.0.0.1:3207');assert(['localhost','127.0.0.1'].includes(base.hostname));
const output=process.env.DIGITAL_ANALYSIS_EVIDENCE_DIR||'/tmp/dx-a4-analysis-evidence';await mkdir(output,{recursive:true});
const id='11111111-1111-4111-8111-111111111111';let saved=null;
const nodes=[
 {key:'development_sewing',label:'开发车板',overdue:1,completed:11,onTime:11,slaDenominator:11},
 {key:'development_assignment',label:'开发核配委派',overdue:2,completed:19,onTime:19,slaDenominator:19},
 {key:'factory_full_cutting',label:'本厂整款开裁',overdue:2,completed:5,onTime:5,slaDenominator:5},
 {key:'test_multi_digit',label:'TEST多位数',overdue:12,completed:123,onTime:98,slaDenominator:123},
 {key:'test_long_label',label:'TEST开发核配委派（客户新增印绣与洗水工艺确认的超长节点名称）',overdue:123,completed:12345,onTime:1234,slaDenominator:12345},
];
const overview={period:{newStyles:18,shippedRounds:11,completed:1,slaDenominator:1,onTime:1,measurable:1,missingTime:0,unverifiedTime:0,handlingSeconds:14400,waitingSeconds:3600,unknownWaiting:0,cycleBuckets:[]},snapshot:{active:12,pending:2,unassigned:2,blocked:0,overdue:140,materialPending:0,handoverPending:0,otherBlocked:0},nodes};
async function assertNodeAlignment(page){
 const cells=await page.locator('.analysis-node-bars>button').evaluateAll(buttons=>buttons.map(button=>{
  const rect=element=>{const {x,y,width,height}=element.getBoundingClientRect();return {x,y,width,height};};
  const text=element=>{const range=document.createRange();range.selectNodeContents(element);return rect(range);};
  const [label,overdue,onTime]=button.children;
  return {button:rect(button),label:rect(label),overdue:rect(overdue),onTime:rect(onTime),overdueText:text(overdue),onTimeText:text(onTime),scrollWidth:button.scrollWidth,clientWidth:button.clientWidth};
 }));
 assert.equal(cells.length,nodes.length,'all screenshot and stress-case nodes must render');
 const center=rect=>rect.y+rect.height/2;
 for(const cell of cells){
  assert(Math.abs(cell.overdue.x-cells[0].overdue.x)<=1,'overdue cells share the same column');
  assert(Math.abs(cell.overdue.width-cells[0].overdue.width)<=1,'overdue cells share the same width');
  assert(Math.abs(center(cell.label)-center(cell.overdue))<=1,'overdue text is vertically centered beside its node');
  assert(Math.abs(cell.overdueText.x+cell.overdueText.width/2-cell.overdue.x-cell.overdue.width/2)<=1,'overdue text is centered within the column');
  assert(Math.abs(cell.onTimeText.x+cell.onTimeText.width-cell.onTime.x-cell.onTime.width)<=1,'on-time text is right aligned');
  assert(cell.label.x+cell.label.width<=cell.overdue.x+1,'node and overdue columns do not overlap');
  assert(cell.scrollWidth<=cell.clientWidth+1,'node row must not clip or overflow');
  if(cell.onTime.x>=cell.overdue.x+cell.overdue.width-1){
   assert(cell.overdue.x+cell.overdue.width<=cell.onTime.x+1,'desktop metric columns do not overlap');
   assert(Math.abs(center(cell.onTime)-center(cell.overdue))<=1,'desktop metrics are vertically centered');
  }else assert(cell.onTime.y>=cell.overdue.y+cell.overdue.height-1,'narrow cards move on-time text to the next row');
 }
}
const row={taskId:id,sourceId:id,orderId:null,styleNo:'TEST-沙盘真值款',customer:'PD',category:'上衣',requiredRole:'pattern_room_worker',assigneeId:id,assigneeName:'TEST板房工人',nodeKey:'development_sewing',label:'开发车板',round:2,state:'completed',createdAt:'2026-10-04T00:00:00Z',enteredAt:'2026-10-04T00:00:00Z',completedAt:'2026-10-04T04:00:00Z',enteredQuality:'现场登记',completedQuality:'已核实',dueAt:'2026-10-05T00:00:00Z',policyVersion:1,events:[],assignmentHistory:[],delegations:[],pendingConditions:[],handlingSeconds:14400,slaIncluded:true,onTime:true,exclusion:null,waitingSeconds:3600,unknownWaiting:0,missingTime:false,unverifiedTime:false,registrationDelaySeconds:10};
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium'});
try{const page=await browser.newPage({viewport:{width:1536,height:960}});await page.addInitScript(()=>sessionStorage.setItem('dx-rework:platform-module','rework'));const errors=[];page.on('pageerror',error=>errors.push(error.message));
await page.route('**/api/**',async route=>{const url=new URL(route.request().url()),path=url.pathname.split('/api/')[1];let body={};
 if(path==='auth/me')body={status:'authorized',user:{id,displayName:'TEST技术主管',businessRoles:['pattern_room_supervisor'],capabilities:[]}};
 else if(path==='digital-production/analysis'){const filters={...Object.fromEntries(url.searchParams),page:Number(url.searchParams.get('page')||1)};body={ruleVersion:'digital-production-p16-v1',asOf:'2026-10-04T08:00:00Z',filters,overview,canExport:false,canRecord:true,page:1,total:1,summary:{newStyles:1,tasks:1,cancelled:0,completed:1,slaDenominator:1,onTime:1,measurable:1,handlingSeconds:14400,waitingSeconds:3600,unknownWaiting:0,missingTime:0,unverifiedTime:0,correctedTasks:1,materialPending:0,handoverPending:0},rounds:[{sourceId:id,round:2,origin:'客户新增要求',categories:['印花'],publishedAt:'2026-10-04T00:00:00Z'}],rows:[row],notes:saved?[{...saved,id,author:'TEST技术主管',createdAt:'2026-10-04T08:00:00Z',ruleVersion:'digital-production-p16-v1'}]:[]};}
 else if(path==='digital-production/analysis/notes'){assert.equal(route.request().method(),'POST');saved=route.request().postDataJSON();assert.deepEqual(saved.taskIds,[id]);body={id};}
 else assert.equal(route.request().method(),'GET');await route.fulfill({json:body});});
await page.goto(new URL('/ui/digital-analysis',base).href);await page.getByRole('heading',{name:'板房数据沙盘',exact:true}).waitFor();await page.getByRole('cell',{name:/TEST-沙盘真值款/}).waitFor();assert.equal(await page.getByText('导出当前授权范围（含规则版本）',{exact:true}).count(),0);
await page.getByRole('checkbox',{name:`引用 ${id}`}).check();await page.locator('.analysis-record-panel>summary').click();await page.getByLabel('发现与原单解释').fill('TEST发现交接瓶颈，已核对原单');await page.getByLabel('拟调整动作').fill('TEST核实预计到料日期并观察后续');await page.getByLabel('后续观察时间（北京时间）').fill('2026-10-05T10:00');await page.getByRole('button',{name:'保存 1 项依据的分析'}).click();await page.locator('.analysis-saved-panel>summary').click();await page.getByRole('heading',{name:'TEST发现交接瓶颈，已核对原单'}).waitFor();
for(const [width,height] of [[1536,960],[1280,900],[1024,900],[951,900],[950,900],[800,900],[430,844],[390,844],[375,844],[320,844]]){await page.setViewportSize({width,height});await assertNodeAlignment(page);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),'page must not overflow viewport');await page.screenshot({path:`${output}/${width}x${height}.png`,fullPage:true});assert(await page.getByRole('heading',{name:'板房数据沙盘',exact:true}).isVisible());}
for(const node of nodes){
 const response=page.waitForResponse(response=>{const url=new URL(response.url());return url.pathname.endsWith('/digital-production/analysis')&&url.searchParams.get('node')===node.key&&url.searchParams.get('scope')==='snapshot'&&url.searchParams.get('metric')==='overdue';});
 await Promise.all([response,page.locator('.analysis-node-bars>button').filter({has:page.getByText(node.label,{exact:true})}).click()]);await page.locator('[data-analysis-ready="true"]').waitFor();
 const query=new URL(page.url()).searchParams;assert.equal(query.get('node'),node.key);assert.equal(query.get('scope'),'snapshot');assert.equal(query.get('metric'),'overdue');await assertNodeAlignment(page);
}
assert.deepEqual(errors,[]);console.log('PASS: actual analysis page, aligned overdue/on-time columns and responsive stress cases at 320–1536px, original node/overdue drill-down, scoped export hidden, referenced improvement note saved/reloaded; synthetic API only.');
}finally{await browser.close();}
