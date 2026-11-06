import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {fullGatePostgresPlan} from '../test-suite-plan.mjs';
export const settingsBrowserRequired=environment=>fullGatePostgresPlan(environment).plan?.some(suite=>suite.path==='tests/integration/m01-settings-native-browser-postgres.test.ts')??false;
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 if(!settingsBrowserRequired(process.env))console.log('SETTINGS_BROWSER_NOT_APPLICABLE: exact canonical plan has no browser suite');
 else{const result=spawnSync(process.execPath,['node_modules/playwright-core/cli.js','install','--with-deps','chromium'],{stdio:'inherit',timeout:180000});if(result.error)throw result.error;if(result.status!==0)throw Error('Canonical settings Chromium preparation failed: '+result.status);console.log('SETTINGS_BROWSER_READY: lock-pinned playwright-core Chromium; original canonical PostgreSQL suite owns run and cleanup');}
}
