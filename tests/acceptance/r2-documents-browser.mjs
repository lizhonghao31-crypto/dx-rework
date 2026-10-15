import assert from 'node:assert/strict';
import sharp from 'sharp';
import PDFDocument from 'pdfkit';
import {DigitalProductionTaskService} from '../../apps/api/src/production-platform/task-service.js';
import {randomUUID} from 'node:crypto';
import {DigitalProductionIdentityService} from '../../apps/api/src/production-platform/identity-service.js';
import {DigitalDevelopmentService} from '../../apps/api/src/production-platform/development-service.js';

export async function documentBrowser({page,context,origin,database,root,worker,taskId,sewingTaskId,checks,out,requests}){
 await context.clearCookies();await context.addCookies([{name:'dx_rework_session',value:root.actorId,url:origin}]);
 const source=new DigitalProductionIdentityService(database,true),forms=new DigitalDevelopmentService(database,true);
 const task=(await database.query('SELECT source_id FROM digital_production_task_access WHERE task_id=$1',[taskId])).rows[0];
 const original=await forms.read(root,task.source_id);
 const draft=await source.createSource(root,{developmentType:'头版',designStyleNo:`TEST-R2-PR04-${randomUUID()}`,temporaryStyleNo:null,customerCode:null},randomUUID());
 await forms.save(root,draft.sourceId,{expectedVersion:0,document:{...original.document,files:[]}},randomUUID());
 const target=`${origin}/ui/digital-production?development=${draft.sourceId}&returnTo=${encodeURIComponent('/ui/digital-cockpit')}`;
 await page.goto(target);await page.getByRole('heading',{name:'本单资料',exact:true}).waitFor();
 assert.equal(await page.getByRole('button',{name:'返回来源',exact:true}).count(),1);
 await page.getByLabel('制作说明（选填）',{exact:true}).fill('TEST PR04 跨章节保留');
 await page.getByRole('button',{name:'打板信息',exact:true}).click();await page.getByLabel('本轮打板数量',{exact:true}).fill('7');
 await page.getByRole('button',{name:'款图与工艺图',exact:true}).click();assert.equal(await page.getByLabel('制作说明（选填）',{exact:true}).inputValue(),'TEST PR04 跨章节保留');
 const image=await sharp({create:{width:90,height:80,channels:3,background:'#2863a4'}}).png().toBuffer();
 const pdf=await new Promise(resolve=>{const document=new PDFDocument(),chunks=[];document.on('data',chunk=>chunks.push(chunk));document.on('end',()=>resolve(Buffer.concat(chunks)));document.text('TEST R2 PR04 film');document.end();});
 const before=requests.filter(item=>item.method==='POST'&&item.url.endsWith('/upload-intents')).length;
 for(const [label,name,mimeType,buffer] of [['主款图','main.png','image/png',image],['局部图','detail.png','image/png',image],['菲林图','film.pdf','application/pdf',pdf],['工艺开发板','craft.png','image/png',image]]){
  await page.getByRole('button',{name:new RegExp(`^${label}（`)}).click();
  await page.locator('#development-upload').setInputFiles({name,mimeType,buffer});
  await page.waitForFunction(()=>!document.querySelector('#development-upload')?.disabled);
 }
 assert.equal(requests.filter(item=>item.method==='POST'&&item.url.endsWith('/upload-intents')).length-before,4);
 await page.locator('.order-document-container>footer').getByRole('button',{name:'保存草稿',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('.order-document-container>footer')?.textContent.includes('草稿 · 版本 2'));
 const saved=await forms.read(root,draft.sourceId);assert.equal(saved.document.instructions,'TEST PR04 跨章节保留');assert.equal(saved.document.quantity,7);assert.deepEqual(saved.document.files.map(file=>file.kind),['款图','局部图','菲林','工艺开发板']);
 await page.screenshot({path:`${out}/pr04-draft-saved.png`});checks.push('PR04 legacy development entry: one container, chapter state preserved, four original upload purposes and save');
 await page.goto(`${origin}/ui/digital-production?development=${original.sourceId}&round=1`);await page.getByRole('heading',{name:'本单资料',exact:true}).waitFor();await page.locator('.development-picture-layout').waitFor();assert.equal(await page.getByRole('button',{name:'保存草稿',exact:true}).count(),0);checks.push('PR04 historic development URL remains immutable');
 const tasks=new DigitalProductionTaskService(database),client=await database.connect();
 try{await client.query('BEGIN');for(const condition of (await client.query("SELECT condition_key FROM digital_production_task_conditions WHERE task_id=$1 AND stage='activation'",[sewingTaskId])).rows)await tasks.setConditionWithClient(client,root,sewingTaskId,condition.condition_key,true);await client.query('COMMIT');}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
 await page.goto(`${origin}/ui/digital-production?task=${sewingTaskId}&taskView=handle`);
 const sewingNote=page.locator(`#development-task-${sewingTaskId} textarea[name=note]`);await sewingNote.fill('TEST PR04 portal retains original form');
 await page.getByRole('button',{name:'本单资料 · 车板成果上传',exact:true}).click();
 await page.locator('.order-document-container input[type=file]').setInputFiles({name:'TEST-sewing-result.png',mimeType:'image/png',buffer:image});
 await page.getByText('已上传 1 份，返回当前办理提交后正式引用。',{exact:true}).waitFor();
 const pending=(await database.query("SELECT attachment_id,task_id FROM digital_development_upload_purposes WHERE source_id=$1 AND purpose='车板成果'",[original.sourceId])).rows;
 assert.equal(pending.length,1);assert.equal(pending[0].task_id,sewingTaskId);
 assert.equal((await database.query('SELECT 1 FROM digital_development_attachment_bindings WHERE attachment_id=$1',[pending[0].attachment_id])).rowCount,0);
 await page.getByRole('button',{name:'当前办理',exact:true}).click();assert.equal(await sewingNote.inputValue(),'TEST PR04 portal retains original form');
 checks.push('PR04 original sewing page: upload lives only in document directory, pending file pins task, return preserves original form');
 await page.goto(`${origin}/ui/digital-production?development=${original.sourceId}&round=1`);await page.locator('.development-picture-layout').waitFor();
 await page.getByRole('button',{name:'面辅料与检测报告',exact:true}).click();
 await page.getByLabel('检测说明 *',{exact:true}).fill('TEST PR04 报告建议，不代替批准');
 await page.getByLabel('报告建议',{exact:true}).selectOption('建议停用');
 await page.locator('input[type=file]').setInputFiles({name:'TEST-fabric-report.pdf',mimeType:'application/pdf',buffer:pdf});
 await page.getByText('本次已上传 1 个文件，尚未提交报告事实。',{exact:true}).waitFor();
 await page.getByRole('button',{name:'保存检测报告',exact:true}).click();
 await page.getByRole('heading',{name:'检测报告',exact:true}).waitFor();
 const reports=(await database.query("SELECT payload FROM digital_development_execution_facts WHERE source_id=$1 AND kind='面料报告'",[original.sourceId])).rows;
 assert.equal(reports.at(-1).payload.recommendation,'建议停用');
 assert.equal((await database.query("SELECT purpose FROM digital_development_upload_purposes WHERE attachment_id=$1",[reports.at(-1).payload.attachmentIds[0]])).rows[0].purpose,'面料报告');
 assert.equal((await database.query("SELECT 1 FROM digital_development_execution_facts WHERE source_id=$1 AND kind='面料决定'",[original.sourceId])).rowCount,0);
 checks.push('PR04 standalone document report uploads with original purpose and never creates an approval');
 const order=(await database.query('SELECT production_order_id FROM digital_production_orders WHERE source_id=$1',[original.sourceId])).rows[0];
 await context.clearCookies();await context.addCookies([{name:'dx_rework_session',value:worker.actorId,url:origin}]);const budgetBefore=requests.filter(item=>item.url.includes(`/orders/${order.production_order_id}/budget`)).length;
 await page.goto(`${origin}/ui/digital-production?budget=${order.production_order_id}&budgetVersion=1`);await page.getByText(/当前身份无权查看此类资料|资料目录读取失败/).waitFor();assert.equal(requests.filter(item=>item.url.includes(`/orders/${order.production_order_id}/budget`)).length,budgetBefore);checks.push('PR04 direct budget URL: directory denies before content or attachment request');
}
