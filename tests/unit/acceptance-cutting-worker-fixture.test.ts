import {describe,expect,it} from "vitest";
import {cuttingWorkerConfiguration} from "../../scripts/acceptance/cutting-worker-maintenance.js";
import {STANDARD_ACCEPTANCE_USERS} from "../../scripts/acceptance/standard-identities.js";
const env={NODE_ENV:"test",ACCEPTANCE_LAB_ENABLED:"true",ROOT_DINGTALK_USER_ID:"uat-root",DINGTALK_CORP_ID:"TEST",ACCEPTANCE_DATABASE_URL:"postgresql://localhost/dx_rework_acceptance_test"};
const id="80000000-0000-4000-8000-000000000001";
describe("fixed single Acceptance cutting-worker fixture configuration",()=>{
 it("defaults to read-only and forces readonly after configured connection options",()=>{
  const config=cuttingWorkerConfiguration({...env,ACCEPTANCE_DATABASE_URL:env.ACCEPTANCE_DATABASE_URL+"?options=-c%20search_path%3Dtest%20-c%20default_transaction_read_only%3Doff"},[]);
  expect(config.apply).toBe(false);expect(new URL(config.connectionString).searchParams.get('options')).toMatch(/default_transaction_read_only=on$/);
 });
 it("pins the only apply target and refuses arbitrary alias/role, ambiguous modes and invalid IDs",()=>{
  expect(cuttingWorkerConfiguration(env,["--apply",`--expected-user-id=${id}`])).toMatchObject({apply:true,expectedUserId:id});
  for(const args of [["--apply"],["--alias=worker-a"],["--role=system_admin"],["--check","--apply"],["--check","--check"],["--expected-user-id=bad"],[`--expected-user-id=${id}`,`--expected-user-id=${id}`]])expect(()=>cuttingWorkerConfiguration(env,args)).toThrow();
 });
 it("refuses production, disabled/mismatched Root configuration, missing corp, unsafe databases and DATABASE_URL fallback",()=>{
  for(const override of [{NODE_ENV:'production'},{ACCEPTANCE_LAB_ENABLED:'false'},{ROOT_DINGTALK_USER_ID:'real-root'},{DINGTALK_CORP_ID:''},{ACCEPTANCE_DATABASE_URL:'postgresql://localhost/production'},{ACCEPTANCE_DATABASE_URL:'https://localhost/test'},{ACCEPTANCE_DATABASE_URL:'invalid-url'},{ACCEPTANCE_DATABASE_URL:'',DATABASE_URL:env.ACCEPTANCE_DATABASE_URL}])expect(()=>cuttingWorkerConfiguration({...env,...override},[])).toThrow();
 });
 it("keeps the old standard catalog distinct; this tool does not enroll cutting-worker in full seeding",()=>{
  expect(STANDARD_ACCEPTANCE_USERS.find(([a])=>a==='pattern-room-worker')).toEqual(['pattern-room-worker','[UAT] 板房师傅','pattern_room_worker']);
  expect(STANDARD_ACCEPTANCE_USERS.find(([a])=>a==='worker-a')?.[2]).toBe('worker');
  expect(STANDARD_ACCEPTANCE_USERS.map(([a])=>a)).not.toContain('cutting-worker');
  expect(new Set(STANDARD_ACCEPTANCE_USERS.map(([a])=>a)).size).toBe(STANDARD_ACCEPTANCE_USERS.length);
 });
});
