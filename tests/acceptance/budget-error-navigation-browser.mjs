import assert from 'node:assert/strict';
import {build} from 'vite';
import {mkdtemp,readFile,readdir,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:http';
const {chromium}=await import(process.env.PLAYWRIGHT_IMPORT||'playwright');
const output=await mkdtemp(join(tmpdir(),'dx-budget-navigation-')),evidence=process.env.BUDGET_NAVIGATION_EVIDENCE,results=[],errors=[];
let server,browser,page;
try{
 await build({configFile:false,esbuild:{jsx:'automatic'},define:{'import.meta.env.BASE_URL':'"/"','process.env.NODE_ENV':'"production"'},build:{outDir:output,lib:{entry:resolve('tests/fixtures/budget-error-navigation.tsx'),name:'BudgetNavigation',formats:['iife']}}});
 const files=await readdir(output),js=await readFile(join(output,files.find(f=>f.endsWith('.js'))),'utf8'),css=await readFile(join(output,files.find(f=>f.endsWith('.css'))),'utf8');
 server=createServer((_req,res)=>{res.setHeader('content-type','text/html;charset=utf-8');res.end(`<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script>${js.replace(/<\/script/gi,'<\\/script')}</script></html>`);});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});if(evidence)await mkdir(evidence,{recursive:true});
 for(const width of [1440,390]){
  page=await browser.newPage({viewport:{width,height:900}});page.on('pageerror',error=>errors.push(error.message));await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.getByRole('textbox',{name:'月份系列',exact:true}).fill('TEST切章输入保留');await page.getByRole('button',{name:'费用与报价',exact:true}).click();await page.getByRole('button',{name:'最终发布',exact:true}).click();
  const locate=async(label,chapter,id)=>{await page.locator('.dx-doc-errors').getByRole('button',{name:label}).click();assert.equal(await page.getByRole('button',{name:chapter,exact:true}).getAttribute('aria-pressed'),'true');assert.equal(await page.evaluate(()=>document.activeElement?.id),id);const rect=await page.locator(`#${id}`).boundingBox();assert.ok(rect&&rect.y>=0&&rect.y<900,'focused error must be scrolled into view');};
  // The original failing route: fees chapter -> missing budget date in other information.
  await page.getByRole('button',{name:'费用与报价',exact:true}).click();await locate(/^预算日期：/,'其他信息','budget-date');for(let tab=0;tab<4&&await page.evaluate(()=>document.activeElement?.id)==='budget-date';tab++)await page.keyboard.press('Tab');assert.notEqual(await page.evaluate(()=>document.activeElement?.id),'budget-date');
  for(const [label,chapter,id]of [['面料属性','基本资料','fabricType'],['产品类别','基本资料','productCategory'],['本次实际外发范围','其他信息','outsourcingScope'],['本次实际外发预算价','其他信息','outsourcingUnitPrice']])await locate(new RegExp(`^${label}：`),chapter,`budget-${id}`);
  for(const [index,chapter]of ['主料','辅料','外发工序'].entries())await locate(new RegExp(`^${chapter} · TEST${chapter} · 单件用量：`),chapter,`budget-00000000-0000-4000-8000-${String(index+10).padStart(12,'0')}-consumption`);
  await page.getByRole('button',{name:'费用与报价',exact:true}).click();for(const label of ['运费','CM加工费用（裁、车、烫、包装）','销售单价（不含税，人民币）'])await page.getByRole('textbox',{name:label,exact:true}).fill('TEST非数字');await page.getByRole('button',{name:'保存预算',exact:true}).click();
  for(const [label,id]of [['运费','freight'],['CM加工费用（裁、车、烫、包装）','cm'],['销售单价（不含税，人民币）','salePrice']]){await page.getByRole('button',{name:'其他信息',exact:true}).click();await locate(new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}：`),'费用与报价',`budget-${id}`);}
  await page.getByRole('button',{name:'基本资料',exact:true}).click();assert.equal(await page.getByRole('textbox',{name:'月份系列',exact:true}).inputValue(),'TEST切章输入保留');assert.equal(await page.getByRole('status').filter({hasText:'未保存修改'}).count(),1);assert.equal(await page.evaluate(()=>window.budgetNavigationFixture.requests.filter(r=>r.method!=='GET').length),0);
  if(evidence)await page.screenshot({path:join(evidence,`budget-navigation-${width}.png`),fullPage:true});results.push({width,checks:12,version:7,writes:0,inputRetained:true});await page.close();page=null;
 }
 assert.deepEqual(errors,[]);
}catch(error){if(evidence&&page&&!page.isClosed()){await page.screenshot({path:join(evidence,'failure.png'),fullPage:true});await writeFile(join(evidence,'failure.txt'),await page.locator('body').innerText());}throw error;}
finally{if(evidence)await writeFile(join(evidence,'result.json'),JSON.stringify({results,errors,limits:['Actual OrderDocumentContainer and DigitalBudgetPanel, synthetic local HTTP; no Acceptance, database or published data changes.']},null,2));await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));await rm(output,{recursive:true,force:true});}
console.log(JSON.stringify({passed:results.length,results,errors}));
