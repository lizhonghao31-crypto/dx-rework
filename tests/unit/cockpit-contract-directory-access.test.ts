import {expect,it,vi} from "vitest";
import type {Pool} from "pg";
import {SourcingService} from "../../apps/api/src/sourcing/sourcing-service.js";
import {documentMetadata} from "../../apps/api/src/production-platform/document-metadata.js";
it("denies contract-directory metadata before any source query without the original contract-data capability",async()=>{
 const query=vi.fn(),service=new SourcingService({query} as unknown as Pool);
 await expect(service.contractDirectory({actorId:"00000000-0000-4000-8000-000000000001",actorRoles:["order_merchandiser"],authorizationCapability:"sourcing:view",authorizationCapabilities:["sourcing:view"],requestId:"TEST-doc-access"},"00000000-0000-4000-8000-000000000002")).rejects.toMatchObject({statusCode:403});
 expect(query).not.toHaveBeenCalled();
});
it("leaves absent authors and timestamps unknown rather than substituting a task owner",async()=>{
 const query=vi.fn().mockResolvedValue({rows:[{id:"editor",display_name:"原修改人"}]});
 const metadata=await documentMetadata({query} as unknown as Pool,{updated_by:"editor",updated_at:"2026-10-01T00:00:00Z"});
 expect(metadata).toEqual({created:{at:null,by:null},edited:{at:"2026-10-01T00:00:00.000Z",by:"原修改人"},published:{at:null,by:null}});
});
