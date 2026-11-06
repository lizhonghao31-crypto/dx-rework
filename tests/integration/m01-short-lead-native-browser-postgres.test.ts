import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {NATIVE_SHORT_LEAD_CASES,runNativeShortLeadBrowser} from '../acceptance/m01-short-lead-native-browser.js';
const databaseUrl=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
(databaseUrl?describe.sequential:describe.skip)('M01 short lead original browser, auth and PostgreSQL matrix',()=>{
 let matrix:ReturnType<typeof runNativeShortLeadBrowser>|undefined,finished=false;
 beforeAll(()=>{matrix=runNativeShortLeadBrowser({tap:false,databaseUrl:databaseUrl!,evidence:process.env.M01_SHORT_LEAD_NATIVE_EVIDENCE??join(process.env.M01_SETTINGS_NATIVE_EVIDENCE??process.env.RUNNER_TEMP??tmpdir(),'m01-short-lead-native-'+randomUUID()),...(process.env.M01_SETTINGS_BROWSER_EXECUTABLE?{executablePath:process.env.M01_SETTINGS_BROWSER_EXECUTABLE}:{})});});
 afterAll(async()=>{if(matrix&&!finished)await matrix.return([]);});
 // Scenario deadlines remain finite; the original fixture is shared only in this sequence.
 for(const name of NATIVE_SHORT_LEAD_CASES)it(name,async()=>{const next=await matrix!.next();expect(next.done).toBe(false);expect(next.value).toBe(name);});
 it('runs original designer request, owner personal todo and original formal confirmation with scoped recovery and revocation',async()=>{const next=await matrix!.next();expect(next.done).toBe(true);expect(next.value).toEqual([...NATIVE_SHORT_LEAD_CASES]);finished=true;});
});
