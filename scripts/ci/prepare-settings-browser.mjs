import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {fullGatePostgresPlan} from '../test-suite-plan.mjs';
const nativeBrowserSuites=new Set(['tests/integration/module-bundles-native-browser-postgres.test.ts','tests/integration/m01-delivery-calendar-native-browser-postgres.test.ts','tests/integration/m01-settings-native-browser-postgres.test.ts','tests/integration/m01-short-lead-native-browser-postgres.test.ts','tests/integration/m01-current-production-native-browser-postgres.test.ts','tests/integration/m01-production-period-native-browser-postgres.test.ts','tests/integration/m01-production-collaboration-native-browser-postgres.test.ts','tests/integration/acceptance-session-retention-postgres.test.ts','tests/integration/m01-cockpit-home-native-browser-postgres.test.ts']);
export const settingsBrowserRequired=environment=>fullGatePostgresPlan(environment).plan?.some(suite=>nativeBrowserSuites.has(suite.path))??false;
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 if(!settingsBrowserRequired(process.env))console.log('SETTINGS_BROWSER_NOT_APPLICABLE: exact canonical plan has no browser suite');
 else{const result=spawnSync(process.execPath,['node_modules/playwright-core/cli.js','install','--with-deps','chromium'],{stdio:'inherit',timeout:180000});if(result.error)throw result.error;if(result.status!==0)throw Error('Canonical settings Chromium preparation failed: '+result.status);console.log('SETTINGS_BROWSER_READY: lock-pinned playwright-core Chromium; original canonical PostgreSQL suite owns run and cleanup');}
}
