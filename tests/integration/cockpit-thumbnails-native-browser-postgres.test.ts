import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {testExecutionConfig} from '../../scripts/test-execution-config.mjs';
import {cockpitHomeBrowser,homeReady} from '../acceptance/m01-cockpit-home-native-browser.js';
vi.setConfig({testTimeout:testExecutionConfig.correctnessTimeoutMs,hookTimeout:testExecutionConfig.correctnessTimeoutMs});
const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
(url?describe.sequential:describe.skip)('PERF05 original complete application private thumbnail browsing',()=>{
 let h:Awaited<ReturnType<typeof cockpitHomeBrowser>>;
 beforeAll(async()=>{h=await cockpitHomeBrowser({databaseUrl:url!,photos:true,productionAssets:true,indexed:true,evidence:join(process.env.M01_SETTINGS_NATIVE_EVIDENCE??tmpdir(),'cockpit-photos-'+randomUUID()),...(process.env.M01_SETTINGS_BROWSER_EXECUTABLE?{executablePath:process.env.M01_SETTINGS_BROWSER_EXECUTABLE}:{})});});
 afterAll(async()=>{await h?.dispose();});
 it('loads an independent320 image, enlarges only the original, and reuses derived bytes after a real reload',async()=>{
  const {context,page}=await h.open(undefined,{search:h.photo!.styleNo},1440);try{
   const photo=h.photo!,image=page.locator(`.journey-orders img[src="${photo.imagePath}/preview"]`);
   await expect.poll(()=>image.evaluate((img:HTMLImageElement)=>img.naturalWidth),{timeout:12000}).toBe(320);
   expect(h.photo!.generationReads()).toBe(1);expect(h.servedImages.some(row=>row.key===photo.objectKey)).toBe(false);
   const thumbnail=h.servedImages.find(row=>row.key.includes('/image-previews/'))!;expect(thumbnail.bytes).toBeLessThan(photo.originalBytes);
   const button=page.locator('.journey-orders .cockpit-photo-trigger');
   for(let attempt=0;attempt<4;attempt++){try{await button.click({timeout:1500});break;}catch(error){const notice=page.locator('[aria-label="站内提醒"]');if(!await notice.isVisible()||attempt===3)throw error;await notice.getByRole('button',{name:'我知道了',exact:true}).click();}}
   const original=page.locator('.cockpit-photo-dialog[open] img');await expect.poll(()=>original.evaluate((img:HTMLImageElement)=>img.naturalWidth),{timeout:12000}).toBe(1200);
   expect(h.servedImages.filter(row=>row.key===photo.objectKey).map(row=>row.bytes)).toEqual([photo.originalBytes]);
   await page.getByRole('button',{name:'关闭款图预览',exact:true}).click();await page.reload();await homeReady(page);
   await expect.poll(()=>page.locator('.journey-orders .cockpit-photo-trigger img').evaluate((img:HTMLImageElement)=>img.naturalWidth),{timeout:12000}).toBe(320);expect(photo.generationReads()).toBe(1);
   await page.screenshot({path:join(h.evidence,'home-1440-thumbnail.png'),fullPage:true});
   await writeFile(join(h.evidence,'actual-image-bytes.json'),JSON.stringify({context:'Owned native PostgreSQL and full App; private loopback TEST object storage, not onsite network or P95',originalBytes:photo.originalBytes,thumbnailBytes:thumbnail.bytes,originalSha256:photo.originalSha256,generationReads:photo.generationReads(),servedImages:h.servedImages},null,2)+'\n');
  }finally{await context.close();}
 });
 it('falls back once to an authorized original on a real preview HTTP error at1165 without a retry loop or blank page',async()=>{
  const {context,page}=await h.open(undefined,{search:h.photo!.styleNo},1165);try{
   let failures=0;await page.route('**'+h.photo!.imagePath+'/preview',async route=>{failures++;await route.fulfill({status:503,body:'TEST derivative unavailable'});});await page.reload();await homeReady(page);
   const image=page.locator('.journey-orders .cockpit-photo-trigger img');await expect.poll(()=>image.evaluate((img:HTMLImageElement)=>img.naturalWidth),{timeout:12000}).toBe(1200);
   expect(await image.getAttribute('src')).toBe(h.photo!.imagePath);expect(failures).toBe(1);expect(await page.locator('.journey-orders tbody tr').count()).toBe(1);
   await page.screenshot({path:join(h.evidence,'home-1165-original-fallback.png'),fullPage:true});
  }finally{await context.close();}
 });
 it('refuses another grant to the same valid PMC browser after native revocation while an independent Root browser still works',async()=>{
  const {context,page}=await h.open(h.pmcId,{search:h.photo!.styleNo});try{
   const response=await page.request.get(h.base+h.photo!.imagePath+'/preview',{maxRedirects:0});expect(response.status()).toBe(302);await h.revokePmc();
   expect((await page.request.get(h.base+'/api/auth/me')).status()).toBe(200);
   expect([403,404]).toContain((await page.request.get(h.base+h.photo!.imagePath+'/preview',{maxRedirects:0})).status());
   const root=await h.open(undefined,{search:h.photo!.styleNo});try{expect((await root.page.request.get(h.base+h.photo!.imagePath+'/preview',{maxRedirects:0})).status()).toBe(302);}finally{await root.context.close();}
  }finally{await context.close();}
 });
});
