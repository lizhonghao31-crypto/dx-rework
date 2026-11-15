import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {fullGatePostgresPlan} from '../test-suite-plan.mjs';
import {prepareSettingsBrowserFonts} from './settings-browser-fonts.mjs';
const nativeBrowserSuites=new Set(['tests/integration/whole-order-deletion-browser-postgres.test.ts','tests/integration/cockpit-thumbnails-native-browser-postgres.test.ts','tests/integration/workspace-page-native-browser-postgres.test.ts','tests/integration/module-bundles-native-browser-postgres.test.ts','tests/integration/journey-page-native-browser-postgres.test.ts','tests/integration/m01-delivery-calendar-native-browser-postgres.test.ts','tests/integration/m01-settings-native-browser-postgres.test.ts','tests/integration/m01-short-lead-native-browser-postgres.test.ts','tests/integration/m01-current-production-native-browser-postgres.test.ts','tests/integration/m01-production-period-native-browser-postgres.test.ts','tests/integration/m01-production-collaboration-native-browser-postgres.test.ts','tests/integration/acceptance-session-retention-postgres.test.ts','tests/integration/m01-cockpit-home-native-browser-postgres.test.ts']);
export const isNativeBrowserSuite=path=>nativeBrowserSuites.has(path)||/^tests\/integration\/[a-z0-9-]+-browser-postgres\.test\.ts$/.test(path);
export const settingsBrowserRequired=environment=>fullGatePostgresPlan(environment).plan?.some(suite=>isNativeBrowserSuite(suite.path))??false;
/** The locked browser and host packages are separate official Playwright steps.
 * Hosted runners already provide the Chromium libraries. Verify an actual
 * launch instead of unconditionally blocking on an unrelated APT index refresh.
 * A missing library or failed launch remains a hard prerequisite failure. */
export function prepareSettingsBrowser(run=spawnSync,prepareFonts=prepareSettingsBrowserFonts){
 const check=(args,timeout)=>{const result=run(process.execPath,args,{stdio:'inherit',timeout});if(result.error)throw result.error;if(result.status!==0)throw Error('Canonical settings Chromium preparation failed: '+result.status);};
 check(['node_modules/playwright-core/cli.js','install','chromium'],180000);
 const fonts=prepareFonts();
 check(['--input-type=module','-e',`import {chromium} from 'playwright-core';const browser=await chromium.launch({headless:true,timeout:20000});try{const page=await browser.newPage();await page.setContent('<html lang="zh-CN"><title>Canonical Chromium readiness</title><span id="chinese" style="font-family:Noto Sans SC Thin,sans-serif">中文工厂收货洗水</span></html>',{timeout:10000});if(await page.title()!=='Canonical Chromium readiness')throw Error('Canonical Chromium readiness failed');const family=${JSON.stringify(fonts?.family??null)};if(family){await page.evaluate(()=>document.fonts.ready);const cdp=await page.context().newCDPSession(page);await cdp.send('DOM.enable');await cdp.send('CSS.enable');const {root}=await cdp.send('DOM.getDocument');const {nodeId}=await cdp.send('DOM.querySelector',{nodeId:root.nodeId,selector:'#chinese'});const {fonts}=await cdp.send('CSS.getPlatformFontsForNode',{nodeId});if(!fonts.some(font=>font.familyName===family&&font.glyphCount===8))throw Error('Canonical Chinese glyph font is unavailable');console.log('SETTINGS_BROWSER_CHINESE_GLYPHS_READY '+JSON.stringify(fonts));}}finally{await browser.close();}`],60000);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 if(!settingsBrowserRequired(process.env))console.log('SETTINGS_BROWSER_NOT_APPLICABLE: exact canonical plan has no browser suite');
 else{prepareSettingsBrowser();console.log('SETTINGS_BROWSER_READY: lock-pinned playwright-core Chromium installed and actual launch verified; original canonical PostgreSQL suite owns run and cleanup');}
}
