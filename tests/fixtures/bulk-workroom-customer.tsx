// Actual workroom component; responses are supplied by the isolated PostgreSQL regression.
import {createRoot} from "react-dom/client";
import {BulkPatternWorkspace} from "../../apps/web/src/bulk-pattern-workspace.js";
import type {BulkWorkroomResult} from "@dx-rework/contracts/bulk-preparation";
import "../../packages/ui/src/tokens.css";
import "../../packages/ui/src/components.css";
import "../../apps/web/src/styles.css";
import "../../apps/web/src/digital-development-workspace.css";
import "../../apps/web/src/digital-kpi-density.css";

const evidence=Reflect.get(window,"bulkCustomerEvidence") as {customer:string;style:string;orderId:string;styleSearch:BulkWorkroomResult;customerSearch:BulkWorkroomResult};
const requests:string[]=[];
Reflect.set(window,"bulkCustomerRequests",requests);
window.fetch=async input=>{
 const path=String(input);requests.push(path);
 const url=new URL(path,location.href);
 if(!url.pathname.endsWith("/workspaces/bulk-pattern"))throw new Error("Unexpected intercepted read: "+path);
 const search=url.searchParams.get("search")??"";
 if(!search||search===evidence.style)return Response.json(evidence.styleSearch);
 if(search.toLowerCase()===evidence.customer.toLowerCase())return Response.json(evidence.customerSearch);
 return Response.json({page:1,pageSize:15,total:0,items:[]});
};
createRoot(document.getElementById("root")!).render(<BulkPatternWorkspace orderId={null} canViewAll/>);
