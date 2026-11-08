import {SupplierDirectoryQuerySchema} from "@dx-rework/contracts/master-data-pages";
import {filterSupplierDirectory,type SupplierSummary} from "../../apps/web/src/supplier-center-model.js";

/** Offline HTTP fixtures only; preserve original filters before slicing. */
export function supplierDirectoryFixturePage(records:readonly SupplierSummary[],url:URL){
 const query=SupplierDirectoryQuerySchema.parse(Object.fromEntries(url.searchParams));
 const matched=filterSupplierDirectory(records,{...query,query:query.q});
 return {page:query.page,pageSize:15,totalCount:matched.length,crafts:[...new Set(records.flatMap(r=>r.supportedCrafts))].sort((a,b)=>a.localeCompare(b,"zh-CN")),items:matched.slice((query.page-1)*15,query.page*15)};
}
export const emptyPeopleFixturePage=(url:URL)=>({pageSize:15,totalCount:0,matchedCount:0,internal:{page:Number(url.searchParams.get("internalPage")??1),totalCount:0,items:[]},temporary:{page:Number(url.searchParams.get("temporaryPage")??1),totalCount:0,items:[]}});
