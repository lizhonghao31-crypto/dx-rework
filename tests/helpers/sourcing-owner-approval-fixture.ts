import type {DecideSourcingOwner,SourcingOwnerReview} from "@dx-rework/contracts";
import type {SourcingService} from "../../apps/api/src/sourcing/sourcing-service.js";
import type {TrustedActorContext} from "../../apps/api/src/tools/repositories.js";

/** Freeze only what the same real fixture actor can read from the original detail. */
export async function readSeenSourcingOwnerReview(service:SourcingService,actor:TrustedActorContext,caseId:string):Promise<SourcingOwnerReview>{
  const result=await service.readDetailSections({
    ...actor,authorizationCapability:"sourcing:view",
    authorizationCapabilities:[...new Set([...(actor.authorizationCapabilities??[]),actor.authorizationCapability,"sourcing:view"])],
  },caseId,true);
  if(!result.ownerReview)throw new Error("TEST owner approval has no visible current basis");
  return result.ownerReview;
}

export async function seenSourcingOwnerDecision(service:SourcingService,actor:TrustedActorContext,caseId:string,input:DecideSourcingOwner):Promise<DecideSourcingOwner>{
  return {...input,...(await readSeenSourcingOwnerReview(service,actor,caseId)).basis};
}

export async function decideSeenSourcingOwner(service:SourcingService,actor:TrustedActorContext,caseId:string,input:DecideSourcingOwner,key:string){
  return service.decideOwner(actor,caseId,await seenSourcingOwnerDecision(service,actor,caseId,input),key);
}
