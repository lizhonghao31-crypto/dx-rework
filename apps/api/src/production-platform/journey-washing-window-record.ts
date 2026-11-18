import {bulkWashingWindowReference,BulkWashingWindowReferenceSchema,type BulkWashingWindowIdentity} from '@dx-rework/contracts/bulk-washing';
import type {JourneyRecord} from '@dx-rework/contracts/digital-production-journey';
import {DigitalIdSchema} from '@dx-rework/contracts/digital-production';

/** Presentation only, after original authorization of this order/work scope.
 * Shared facts carry native IDs, never URLs or an authorization conclusion. */
export function journeyWashingWindowRecord(orderId:string,lineId:string|null,evidence:string,identity:BulkWashingWindowIdentity|undefined):JourneyRecord|undefined{
 if(!identity||!DigitalIdSchema.safeParse(orderId).success||!DigitalIdSchema.safeParse(lineId).success)return undefined;
 const reference=bulkWashingWindowReference(identity.scopeId,identity.windowId);
 if(evidence!==reference||!BulkWashingWindowReferenceSchema.safeParse(reference).success)return undefined;
 const query=new URLSearchParams({factory:orderId,factoryAction:'washing',line:lineId!,washingWindow:reference});
 return {domain:'factory',id:orderId,url:'/ui/digital-production?'+query,mode:'read',version:null,lineId};
}
