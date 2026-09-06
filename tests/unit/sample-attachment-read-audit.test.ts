import {randomUUID} from "node:crypto";
import Fastify from "fastify";
import {expect,it,vi} from "vitest";
import {registerSampleCreateRoutes,type SampleCreateHttpDependencies} from "../../apps/api/src/samples/sample-create-routes.js";
it("records designer attachment downloads under the read capability actually held",async()=>{
 const app=Fastify(),sampleId=randomUUID(),attachmentId=randomUUID(),userId=randomUUID();
 const download=vi.fn(async()=>({downloadUrl:"https://example.test/signed-image"}));
 registerSampleCreateRoutes(app,{
  authenticate:async()=>({id:userId,displayName:"测试设计师",businessRoles:["sample_designer"],capabilities:["sample:view_basic"]}),
  service:{},files:{list:async()=>({attachments:[{attachmentId,purpose:"sample_image",filename:"test.png",mimeType:"image/png",sizeBytes:10}]}),canDownload:async()=>true},
  attachments:{createDownloadIntent:download},
 } as unknown as SampleCreateHttpDependencies);
 try{
  const result=await app.inject({method:"GET",url:`/samples/${sampleId}/attachments/${attachmentId}/download`,headers:{cookie:"dx_rework_session=fixture"}});
  expect(result.statusCode).toBe(302);
  expect(download.mock.calls[0]?.[0]).toMatchObject({actorId:userId,authorizationCapability:"sample:view_basic",authorizationCapabilities:["sample:view_basic"]});
 }finally{await app.close();}
});
