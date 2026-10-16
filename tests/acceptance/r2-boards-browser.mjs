import assert from 'node:assert/strict';
export async function boardsBrowser({page,context,origin,root,taskId,checks,out,requests}){
 await context.clearCookies();await context.addCookies([{name:'dx_rework_session',value:root.actorId,url:origin}]);
 const get=async path=>{const r=await page.request.get(origin+'/api/'+path);assert.equal(r.status(),200,path);return r.json();};
 const task=await get('digital-production/tasks/'+taskId);const keyword=task.identity.designStyleNo;
 await page.goto(origin+'/ui/digital-pattern-room?scope=all&state=all&search='+encodeURIComponent(keyword));await page.locator('.pattern-task-card').first().waitFor();
 assert.equal(await page.getByRole('button',{name:'向左查看环节',exact:true}).count(),0);assert.equal(await page.getByLabel('选中任务详情').count(),0);assert.equal(await page.locator('.pattern-lane-heading .pattern-lane-more').count(),7);
 const before=requests.length;await page.locator('.lane-pattern .pattern-lane-more').click();await page.waitForResponse(r=>r.url().includes('/workspaces/pattern?')&&new URL(r.url()).searchParams.get('lane')==='pattern');await page.locator('.pattern-task-card').first().waitFor();
 assert.equal(new URL(page.url()).searchParams.get('lane'),'pattern');assert(requests.slice(before).some(r=>r.url.includes('lane=pattern')));const developmentQuery=new URL(page.url()).search;
 await page.locator('.pattern-task-card').first().click();await page.getByLabel('工序工作台样板').waitFor();assert.equal(new URL(page.url()).pathname,'/ui/digital-production');await page.getByRole('button',{name:'返回来源',exact:true}).click();await page.waitForURL(url=>url.search===developmentQuery);await page.locator('.pattern-task-card').first().waitFor();checks.push('PR08 development header full-list re-queries scope and task opens native workbench with exact return');
 await page.getByRole('button',{name:'显示全部环节',exact:true}).click();await page.locator('.pattern-board-column').nth(6).waitFor();await page.locator('.pattern-task-card').first().waitFor();
 for(const width of [1440,1600,1165]){await page.setViewportSize({width,height:width===1165?757:900});await page.screenshot({path:`${out}/pr08-development-${width}.png`});}
 const devSearch=new URL(page.url()).search;const switching=requests.length;
 await page.getByRole('button',{name:'大货纸样与唛架',exact:true}).click();await page.getByLabel('大货纸样与唛架岗位任务').waitFor();await page.getByRole('status').filter({hasText:'读取真实大货任务'}).waitFor({state:'hidden'});
 assert.equal(await page.locator('.bulk-pattern-columns .pattern-board-column').count(),4);assert.equal(await page.locator('.bulk-workroom-list table').count(),0);assert(!requests.slice(switching).some(r=>r.url.includes('/workspaces/pattern?')));
 await page.getByLabel('关键词',{exact:true}).fill(keyword);await page.getByRole('button',{name:'查询',exact:true}).click();await page.getByRole('status').filter({hasText:'读取真实大货任务'}).waitFor({state:'hidden'});const bulkSearch=new URL(page.url()).search;
 await page.screenshot({path:out+'/pr08-bulk.png'});await page.getByRole('button',{name:'开发岗位任务',exact:true}).click();assert.equal(new URL(page.url()).search,devSearch);await page.locator('.pattern-task-card').first().waitFor();await page.getByRole('button',{name:'大货纸样与唛架',exact:true}).click();assert.equal(new URL(page.url()).search,bulkSearch);await page.getByRole('status').filter({hasText:'读取真实大货任务'}).waitFor({state:'hidden'});
 await page.locator('.bulk-pattern-columns .pattern-task-card').first().click();await page.getByLabel('大货工序工作台',{exact:true}).waitFor();assert.equal(await page.getByRole('link',{name:'返回开发工作台',exact:true}).count(),0);await page.getByRole('button',{name:'返回来源',exact:true}).click();await page.waitForURL(url=>url.search===bulkSearch);await page.getByLabel('大货纸样与唛架岗位任务').waitFor();checks.push('PR08 bulk native task exact return preserves its independent section and query');
 checks.push('PR08 bulk shares four card lanes; switching retains separate queries without loading inactive development chain');
}
