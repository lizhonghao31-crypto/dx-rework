import {describe,it,expect} from "vitest";
import {validateHistoryIdentity,summarizeHistoryBatch} from "../../scripts/deploy/contract-return-history.mjs";
describe("explicit three-case command guards and exact replay counts",()=>{
  const deploy={DX_REWORK_PROFILE:"production",DX_REWORK_SERVER_NAME:"dxerp.org.cn",DX_REWORK_NGINX_MODE:"dedicated_vhost"};
  const identity={database:"dx_rework",username:"dx_rework_app",superuser:false,bypassrls:false};
  it("requires the production profile, exact app database/user and non-superuser execution",()=>{
    expect(()=>validateHistoryIdentity(deploy,identity)).not.toThrow();
    for(const bad of [{...identity,database:"acceptance"},{...identity,username:"postgres"},{...identity,superuser:true},{...identity,bypassrls:true}])expect(()=>validateHistoryIdentity(deploy,bad)).toThrow("APPLICATION_DATABASE_IDENTITY_REQUIRED");
    expect(()=>validateHistoryIdentity({...deploy,DX_REWORK_PROFILE:"acceptance"},identity)).toThrow("PRODUCTION_PROFILE_REQUIRED");
  });
  it("counts actual creations, skips, failures and unexecuted items without counting a replay as new work",()=>{
    const results=[{caseId:"a",action:"created",createdTodoIds:["1","2"],cycleCreated:true},{caseId:"b",action:"skipped_signed",createdTodoIds:[]},{caseId:"c",action:"failed",createdTodoIds:[]}];
    expect(summarizeHistoryBatch({reused:false,results},[{caseId:"d",reason:"blocked"}])).toMatchObject({createdThisInvocation:2,cyclesCreatedThisInvocation:1,skipped:1,failed:1,notExecuted:[{caseId:"d",reason:"blocked"}]});
    expect(summarizeHistoryBatch({reused:true,results})).toMatchObject({createdThisInvocation:0,cyclesCreatedThisInvocation:0,reused:true});
  });
});
