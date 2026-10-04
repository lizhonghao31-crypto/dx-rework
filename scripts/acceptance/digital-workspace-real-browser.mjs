import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import {mintAcceptanceLoginCode} from '../../apps/api/src/auth/acceptance-provider.ts';
const base=new URL(process.env.A4_UI_BASE_URL??'http://127.0.0.1:3200');
assert(['127.0.0.1','localhost'].includes(base.hostname),'local browser target only');
assert(process.env.A4_UI_ENV_FILE,'explicit local test environment required');
const env=JSON.parse(await readFile(process.env.A4_UI_ENV_FILE,'utf8'));
const database=new URL(env.DATABASE_URL);assert(['localhost','127.0.0.1'].includes(database.hostname));assert.equal(database.pathname,'/dx_a4_ui_acceptance');assert.equal(env.ACCEPTANCE_LAB_ENABLED,'true');
const output=process.env.A4_UI_EVIDENCE_DIR??'/tmp/dx-a4-ui-real-evidence';await mkdir(output,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH??'/usr/bin/chromium'});
const result=[];let activePage,authorizedImageUrl;
try{
 for(const [alias,canManage] of [['root',true],['production-management',true],['pattern-room-supervisor',false],['worker-a',false]]){
  for(const [width,height] of [[1536,960],[390,844]]){
   const context=await browser.newContext({viewport:{width,height}}),page=await context.newPage(),errors=[];
   activePage=page;console.log(`START ${alias} ${width}`);
   page.on('pageerror',error=>errors.push(error.message));
   const login=await context.request.post(new URL('/api/auth/mobile',base).href,{data:{code:mintAcceptanceLoginCode(alias,env.ACCEPTANCE_LAB_SECRET)}});assert.equal(login.status(),200,`normal login ${alias}`);
   const me=await context.request.get(new URL('/api/auth/me',base).href);assert.equal(me.status(),200);const actor=(await me.json()).user;
   const provenance=async()=>{await page.evaluate(()=>{document.getElementById('local-evidence-label')?.remove();const label=document.createElement('div');label.id='local-evidence-label';label.textContent='本机真实 API / PG13 · 标准测试账号 · TEST 数据 · 非线上 Acceptance';label.style.cssText='padding:5px 10px;background:#fff5d8;color:#674900;font-size:11px;position:relative;z-index:1';document.querySelector('.app-shell > main')?.prepend(label);});};
   const clickNav=async(name)=>{let link=page.getByRole('link',{name});if(await link.count()===0&&width<800){await page.locator('.mobile-primary-navigation__more > summary').click();link=page.getByRole('link',{name});}await link.first().click();};
   await page.goto(new URL('/ui/home',base).href);await page.waitForFunction(()=>!location.pathname.endsWith('/ui/home'));if(alias!=='worker-a')await page.locator('.app-shell').waitFor();
   if(alias==='worker-a'){
    assert.equal(await page.getByRole('link',{name:/生产管理座舱|^数字生产$/}).count(),0);
    assert(authorizedImageUrl,'authorized image URL captured from live root response');const deniedImage=await context.request.get(new URL(authorizedImageUrl,base).href);assert([403,404].includes(deniedImage.status()),'image denies unrelated worker');
    const denied=await context.request.get(new URL('/api/digital-production/cockpit',base).href);assert([403,404].includes(denied.status()),`denied API: ${denied.status()}`);
    await page.goto(new URL('/ui/digital-cockpit',base).href);await page.getByText(/没有权限|无权|无访问权限|不具备|不在.*范围/).first().waitFor();
    await page.screenshot({path:`${output}/${alias}-${width}-denied.png`,fullPage:true});
    result.push({alias,width,actor:actor.displayName,deniedStatus:denied.status(),path:'home → no digital entry; direct route/API denied'});await context.close();continue;
   }
   await clickNav(/生产管理座舱|^数字生产$/);await page.getByRole('heading',{name:'生产管理座舱',exact:true}).waitFor();
   await page.getByRole('button',{name:'TEST-A4-UI-8',exact:true}).waitFor();
   assert.equal(await page.locator('.production-command-summary article').count(),5);
   const image=page.getByRole('img',{name:'TEST-A4-UI-IMAGE 款图'}).first();await image.waitFor();await page.waitForFunction(()=>{const node=document.querySelector('img[alt="TEST-A4-UI-IMAGE 款图"]');return node?.complete&&node.naturalWidth>0;});authorizedImageUrl=await image.getAttribute('src');
   if(width<800)assert.equal(await page.locator('.production-command-summary').evaluate(node=>getComputedStyle(node).gridTemplateColumns.split(' ').length),2,'mobile two-column cards');
   assert.equal(await page.getByRole('button',{name:'工序时效设定',exact:true}).count(),canManage?1:0);
   assert((await page.locator('.production-command-welcome').innerText()).includes(actor.displayName));
   await page.getByRole('button',{name:'TEST-A4-UI-2',exact:true}).click();await page.getByRole('heading',{name:'TEST-A4-UI-2',exact:true}).waitFor();
   assert((await page.locator('.production-command-risk-list').innerText()).includes('TEST资料待核对'));
   await page.getByRole('button',{name:'单据与PO',exact:true}).click();await page.getByText('TEST-PO-B · 白 · 50 件',{exact:true}).waitFor();
   await page.getByRole('button',{name:'节点历史',exact:true}).click();assert(await page.getByText('历史只读，具体权限仍由原业务页核验。',{exact:true}).isVisible());
   await page.getByRole('button',{name:'生产进度',exact:true}).click();
   if(width<800){const boxes=await page.locator('.production-command-timeline-item').evaluateAll(nodes=>nodes.map(node=>({y:node.getBoundingClientRect().y,x:node.getBoundingClientRect().x})));assert.equal(boxes.length,7);assert(boxes.every((box,index)=>index===0||(box.y>boxes[index-1].y&&Math.abs(box.x-boxes[0].x)<1)),'mobile vertical route');assert(await page.locator('.production-command-current-node dd').nth(1).evaluate(node=>node.getBoundingClientRect().width>=150),'readable node dates');}

   if(canManage){await page.getByRole('button',{name:'工序时效设定',exact:true}).click();await page.getByRole('dialog',{name:'工序时效设定'}).waitFor();await page.getByRole('button',{name:'关闭',exact:true}).click();}
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),'no document overflow');
   await provenance();await page.screenshot({path:`${output}/${alias}-${width}-cockpit.png`,fullPage:true});
   await clickNav(/板房数据沙盘/);await page.getByRole('heading',{name:'板房数据沙盘',exact:true}).waitFor();await page.getByText(/digital-production-p16-v1/).first().waitFor();assert.equal(await page.locator('.digital-workspace').count(),1);await provenance();await page.screenshot({path:`${output}/${alias}-${width}-analysis.png`,fullPage:true});
   await clickNav(/开发与大货办理/);await page.getByRole('heading',{name:/数字生产/}).first().waitFor();assert.equal(await page.locator('.digital-workspace').count(),1);
   await clickNav(/生产管理座舱|^数字生产$/);await page.getByRole('heading',{name:'生产管理座舱',exact:true}).waitFor();await page.getByRole('link',{name:/查看我的实际待办/}).click();await page.waitForURL(url=>url.pathname==='/ui/my-tasks');assert.equal(await page.locator('a[href$="/ui/todos"]').count(),0);
   assert.deepEqual(errors,[]);result.push({alias,width,actor:actor.displayName,canManage,path:'home → cockpit → actual order/PO/history → analysis → original work → cockpit → my-tasks',api:'real local server, no route interception'});await context.close();
  }
 }
 await writeFile(`${output}/result.json`,JSON.stringify({provenance:'local real API/PG13, standard UAT sessions and TEST fixtures; not deployed Acceptance',result},null,2));console.log(JSON.stringify({passed:true,scenarios:result.length,output}));
}catch(error){if(activePage&&!activePage.isClosed()){await activePage.screenshot({path:`${output}/failure.png`,fullPage:true});console.error('Failed URL',activePage.url());}throw error;}finally{await browser.close();}
