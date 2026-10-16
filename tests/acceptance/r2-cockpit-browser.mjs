// PR07: local real-service read-only cockpit/return evidence using the existing synthetic order.
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
export async function cockpitBrowser({page,context,origin,root,taskId,checks,out}) {
 await context.clearCookies();await context.addCookies([{name:'dx_rework_session',value:root.actorId,url:origin}]);
 const get=async path=>{const response=await page.request.get(origin+'/api/digital-production/'+path);assert.equal(response.status(),200,path);return response.json();};
 const task=await get('tasks/'+taskId),order=await get('journeys/'+task.sourceId);
 await writeFile(out+'/pr07-snapshot.json',JSON.stringify({detail:order,data:await get('journeys?search='+encodeURIComponent(order.designStyleNo))}));
 const nodes=order.stages.flatMap(stage=>stage.nodes),work=nodes.filter(node=>node.current&&['active','blocked'].includes(node.state));
 const base='/ui/digital-cockpit?search=TEST&page=2&selected='+order.id;
 await page.setViewportSize({width:1600,height:900});await page.goto(origin+base);await page.getByLabel('订单全景详情').waitFor();
 assert.equal(await page.locator('.journey-preparation-reference').count(),0);
 const selectedStage=await page.locator('.journey-stage-wrap.is-expanded').innerText();assert(work.length&&selectedStage.includes(order.stages.find(stage=>stage.key===work[0].stage).label));
 const visible=nodes.filter(node=>node.stage===work[0].stage&&node.state!=='not_applicable');
 assert.equal(await page.locator('.journey-node-table tbody>tr').count(),visible.length);
 const progress=await page.locator('.journey-progress-panel').innerText();
 const geometry=[];
 for(const width of [1440,1600,1165]){
  await page.setViewportSize({width,height:width===1165?757:900});await page.screenshot({path:`${out}/pr07-cockpit-${width}.png`});
  const boxes=await page.evaluate(()=>Object.fromEntries(['.journey-flow-panel','.journey-current-panel','.journey-progress-panel','.journey-risk-panel','.journey-node-panel','.journey-documents-panel','.journey-activity-panel'].map(selector=>{const r=document.querySelector(selector).getBoundingClientRect();return[selector,{x:r.x,y:r.y,width:r.width,height:r.height}];})));
  assert.equal(boxes['.journey-current-panel'].y,boxes['.journey-progress-panel'].y);assert.equal(boxes['.journey-node-panel'].x,boxes['.journey-current-panel'].x);assert.equal(boxes['.journey-documents-panel'].x,boxes['.journey-progress-panel'].x);assert.equal(boxes['.journey-activity-panel'].x,boxes['.journey-risk-panel'].x);geometry.push({width,boxes});
 }
 await writeFile(out+'/pr07-geometry.json',JSON.stringify(geometry,null,2));checks.push('PR07 real journey defaults to current phase; approved panel grid retained at three desktop widths');
 await page.getByRole('button',{name:'全部阶段',exact:true}).click();assert.equal(await page.locator('.journey-node-table tbody>tr').count(),nodes.filter(n=>n.state!=='not_applicable').length);assert.equal(await page.locator('.journey-progress-panel').innerText(),progress);
 await page.getByRole('button',{name:order.stages.find(s=>s.key==='preparation').label+'节点明细',exact:true}).click();assert.equal(await page.locator('.journey-node-table tbody>tr').count(),nodes.filter(n=>n.stage==='preparation'&&n.state!=='not_applicable').length);assert.equal(await page.locator('.journey-progress-panel').innerText(),progress);
 checks.push('PR07 stage/all-stage switches preserve whole-order progress and exclude only not-applicable facts');
 const exact=nodes.find(n=>n.records.some(r=>r.domain==='task'&&new URL(r.url,origin).searchParams.get('task')===taskId));assert(exact);
 await page.goto(origin+base+'&expanded='+exact.stage+'&focus='+encodeURIComponent(exact.instanceId)+'&row='+encodeURIComponent(exact.instanceId));await page.getByLabel('订单全景详情').waitFor();
 const href=await page.locator('.journey-current-records a').filter({hasText:'原任务'}).first().getAttribute('href');assert(href);const expected=new URL(href,origin).searchParams.get('returnTo');
 await page.goto(new URL(href,origin).href);await page.getByLabel('工序工作台样板').waitFor();assert.equal(await page.getByRole('button',{name:'返回来源',exact:true}).count(),1);assert.equal(await page.locator('.journey-return-link').count(),0);
 await page.getByRole('button',{name:'本单资料',exact:true}).click();await page.getByRole('navigation',{name:'本单资料目录'}).waitFor();await page.getByRole('button',{name:'返回来源',exact:true}).click();await page.waitForURL(url=>url.pathname+url.search===expected);await page.getByLabel('订单全景详情').waitFor();
 checks.push('PR07 cockpit → exact historical task → documents → single source return restores page/filter/phase/focus/row');
 await page.locator('.journey-documents-panel').getByRole('link',{name:'本单资料',exact:true}).click();await page.getByRole('navigation',{name:'本单资料目录'}).waitFor();assert.equal(await page.getByRole('button',{name:'返回来源',exact:true}).count(),1);assert.equal(await page.locator('.journey-return-link').count(),0);await page.getByRole('button',{name:'返回来源',exact:true}).click();await page.getByLabel('订单全景详情').waitFor();
 checks.push('PR07 related documents uses PR04 container with exactly one source return');
 await page.goto(origin+'/ui/digital-cockpit?search='+encodeURIComponent(order.designStyleNo));await page.locator('.journey-orders[aria-busy=false]').waitFor();
 assert.equal(await page.getByRole('columnheader',{name:'命中原因',exact:true}).count(),0);assert.equal(await page.getByRole('columnheader',{name:'当前任务 / 等待原因',exact:true}).count(),1);
 await page.screenshot({path:out+'/pr07-overview.png'});
 checks.push('PR07 overview combines work, waiting causes and risk matches in current-task column');
}
