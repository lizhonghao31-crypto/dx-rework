import {createWebUrls} from '../url-contract.js';

export type PendingReceivingSelection={styleNo:string;actualCutCount:number;cuttingOrderId:string;productionOrderId:string;factoryDecisionId:string|null;
 receivingBatchId:string|null;documentQuantity:number|null;supplierName:string|null;poNumber:string|null;color:string|null;remaining:number};
const {pageUrl}=createWebUrls(import.meta.env.BASE_URL);

export function pendingReceivingReturn(raw:string|null){
 if(!raw)return null;
 try{const url=new URL(raw,window.location.origin);return url.origin===window.location.origin&&url.pathname===pageUrl('/ui/orders')&&url.searchParams.get('view')==='pending'?url.pathname+url.search+url.hash:null;}catch{return null;}
}
