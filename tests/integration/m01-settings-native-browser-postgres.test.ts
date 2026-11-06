import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {NATIVE_SETTINGS_CASES,runNativeSettingsBrowser} from '../acceptance/m01-settings-native-browser.js';
const databaseUrl=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
(databaseUrl?describe.sequential:describe.skip)('M01 settings original browser, auth and PostgreSQL matrix',()=>{
 let matrix:ReturnType<typeof runNativeSettingsBrowser>|undefined,finished=false;
 beforeAll(()=>{matrix=runNativeSettingsBrowser({tap:false,databaseUrl:databaseUrl!,evidence:process.env.M01_SETTINGS_NATIVE_EVIDENCE??join(process.env.RUNNER_TEMP??tmpdir(),'m01-settings-native-'+randomUUID()),...(process.env.M01_SETTINGS_BROWSER_EXECUTABLE?{executablePath:process.env.M01_SETTINGS_BROWSER_EXECUTABLE}:{})});});
 afterAll(async()=>{if(matrix&&!finished)await matrix.return([]);});
 // Keep each real scenario within the existing finite timeout. The same original
 // fixture and browser stay owned by this sequential suite, never by another test.
 for(const name of NATIVE_SETTINGS_CASES)it(name,async()=>{const next=await matrix!.next();expect(next.done).toBe(false);expect(next.value).toBe(name);});
 it('runs the complete settings route/publication/recovery/authorization matrix through original components, services and AuthService',async()=>{const next=await matrix!.next();expect(next.done).toBe(true);expect(next.value).toEqual([...NATIVE_SETTINGS_CASES]);finished=true;});
});
