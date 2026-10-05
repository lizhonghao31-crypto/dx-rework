import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
const dir=process.env.V2_SHELL_EVIDENCE_DIR||'/tmp/dx-v2-shell-evidence';await mkdir(dir,{recursive:true});
const id='11111111-1111-4111-8111-111111111111';
const roles=['sample_designer','order_merchandiser','owner_group','warehouse_receiver','pattern_room_supervisor','system_admin'];
const caps=['todo:view','pattern_room:orders:create','pattern_room:orders:view','pattern_room:prices:read','sourcing:view','access:admin','admin:read','supplier_profile:read','sample:view_basic','sample:view_finance','report:view','cutting:orders:view','cutting:records:create','receiving:create'];
const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true});
const results=[];
async function pageFor(port,root=true,role='pattern_room_worker'){
 const p=await browser.newPage({viewport:{width:1672,height:941}});
 await p.route('**/api/**',async r=>{let body={};const path=new URL(r.request().url()).pathname.split('/api/')[1];if(path?.includes('notifications')){await r.fulfill({status:404,json:{}});return;}
 if(path==='auth/me')body={status:'authorized',user:{id,displayName:'TEST 公共壳身份',isRoot:root,businessRoles:root?roles:[role],capabilities:root?caps:[]}};
 else if(path?.startsWith('digital-production/cockpit'))body={actorId:id,actorName:'TEST 公共壳身份',canViewTodos:root,canManagePolicies:root,total:0,page:1,summary:{active:0,blocked:0,overdue:0,dueSoon:0,unknown:0},items:[]};
 else if(path==='todos/mine/indicator')body={pendingCount:0};
 else if(path?.includes('notifications'))body={items:[]};
 else if(path?.startsWith('digital-production/options'))body={creationEnabled:false,customers:[]};
 else if(path?.startsWith('digital-production/access/options'))body={users:[],roles:[]};
 else {await r.fulfill({status:503,json:{error:{code:'TEST_SOURCE_UNAVAILABLE',message:'TEST 数据源不可用'}}});return;}
 assert.equal(r.request().method(),'GET');await r.fulfill({json:body,headers:{'x-dx-rework-actor-id':id}});
 });return p;
}
try{
 const root=await pageFor(3206);
 await root.goto('http://127.0.0.1:3206/ui/digital-cockpit');await root.getByRole('heading',{name:'生产管理座舱',exact:true}).waitFor();await root.locator('.current-user').waitFor();
 assert.equal(await root.locator('.current-user').count(),1);assert.equal(await root.locator('.production-command-topbar').count(),0);
 const nav=root.locator('.desktop-navigation');
 const text=await nav.innerText();assert(text.indexOf('外发定价&选厂')<text.indexOf('订单开裁'));
 await root.getByText('当前授权筛选范围暂无订单或开发来源').waitFor().catch(()=>{});await root.screenshot({path:dir+'/1672-shell.png',fullPage:true});
 await nav.getByText('大货产前准备',{exact:true}).first().click();await nav.getByRole('link',{name:'大货产前准备'}).click();await root.locator('button[aria-pressed=true]').filter({hasText:'大货生产'}).waitFor();
 assert.equal(await root.locator('.desktop-navigation a[aria-current=page]').count(),1);
 await root.setViewportSize({width:390,height:844});assert.equal(await root.locator('.app-shell > aside').isVisible(),false);await root.getByLabel('更多导航').click();assert(await root.getByRole('navigation',{name:'移动端主导航'}).getByRole('link',{name:'板房管理台'}).isVisible());await root.screenshot({path:dir+'/390-shell.png',fullPage:true});
 const worker=await pageFor(3206,false);await worker.goto('http://127.0.0.1:3206/ui/digital-cockpit');await worker.locator('.current-user').waitFor();
 assert.equal(await worker.locator('.desktop-navigation').getByText('外发定价&选厂',{exact:true}).count(),0);assert.equal(await worker.locator('.desktop-navigation').getByText('设计师创建订单',{exact:true}).count(),0);assert.equal(await worker.locator('.desktop-navigation').getByRole('link',{name:'我的待办',exact:true}).count(),0);
 await worker.screenshot({path:dir+'/1672-worker.png',fullPage:true});
 const old=await pageFor(3207);const now=await pageFor(3206);
 for(const path of ['/ui/sourcing/pending','/ui/cutting','/ui/orders','/ui/tasks','/ui/suppliers','/ui/samples','/ui/finance','/ui/pattern-room/orders','/ui/admin']){
  await old.goto('http://127.0.0.1:3207'+path);await now.goto('http://127.0.0.1:3206'+path);await old.locator('.current-user').waitFor();await now.locator('.current-user').waitFor();
  await old.waitForTimeout(250);await now.waitForTimeout(250);
  const a=await old.locator('.app-shell > main').innerText(),b=await now.locator('.app-shell > main').innerText();
  assert.equal(b,a,'mature page content '+path);results.push({path,mainTextEqual:true,fixture:'synthetic empty/error states'});
 }
 await writeFile(dir+'/result.json',JSON.stringify({viewport:[1672,941],mobile:[390,844],shell:'PASS',rootAndWorker:'PASS',legacy:results,acceptance:false},null,2));
 console.log('PASS shell, root/worker menu positives and negatives, bulk route, 390 mobile drawer, 9 unchanged mature page empty/error main texts. Read-only synthetic fixture; not Acceptance.');
}finally{await browser.close();}
