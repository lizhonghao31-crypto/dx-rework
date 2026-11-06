import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {NATIVE_PRODUCTION_PERIOD_CASES,runNativeCurrentProductionBrowser} from '../acceptance/m01-current-production-native-browser.js';
const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
(url?describe.sequential:describe.skip)('M01 P10 period original browser, guarded clock, auth and retained export matrix',()=>{
 let matrix:ReturnType<typeof runNativeCurrentProductionBrowser>|undefined,finished=false;
 beforeAll(()=>{matrix=runNativeCurrentProductionBrowser({databaseUrl:url!,periodOnly:true,evidence:join(process.env.M01_SETTINGS_NATIVE_EVIDENCE??process.env.RUNNER_TEMP??tmpdir(),'m01-production-period-'+randomUUID()),...(process.env.M01_SETTINGS_BROWSER_EXECUTABLE?{executablePath:process.env.M01_SETTINGS_BROWSER_EXECUTABLE}:{})});});
 afterAll(async()=>{if(matrix&&!finished)await matrix.return([]);});
 for(const name of NATIVE_PRODUCTION_PERIOD_CASES)it(name,async()=>{const next=await matrix!.next();expect(next.done).toBe(false);expect(next.value).toBe(name);});
 it('completes the original production-period browser matrix and exact owned resource cleanup',async()=>{const next=await matrix!.next();expect(next.done).toBe(true);expect(next.value).toEqual([...NATIVE_PRODUCTION_PERIOD_CASES]);finished=true;});
});
