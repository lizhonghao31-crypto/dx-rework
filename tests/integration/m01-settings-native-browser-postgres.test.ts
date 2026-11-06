import {describe,it,expect} from 'vitest';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {runNativeSettingsBrowser} from '../acceptance/m01-settings-native-browser.js';
const databaseUrl=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
(databaseUrl?describe:describe.skip)('M01 settings original browser, auth and PostgreSQL matrix',()=>{
 it('runs the complete settings route/publication/recovery/authorization matrix through original components, services and AuthService',async()=>{const results=await runNativeSettingsBrowser({tap:false,databaseUrl:databaseUrl!,evidence:process.env.M01_SETTINGS_NATIVE_EVIDENCE??join(process.env.RUNNER_TEMP??tmpdir(),'m01-settings-native-'+randomUUID()),...(process.env.M01_SETTINGS_BROWSER_EXECUTABLE?{executablePath:process.env.M01_SETTINGS_BROWSER_EXECUTABLE}:{})});expect(results).toHaveLength(24);});
});
