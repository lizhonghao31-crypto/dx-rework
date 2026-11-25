import type {FactoryFlowSheet} from '@dx-rework/contracts/factory-flow';
import type {TrustedActorContext} from '../tools/repositories.js';
import {digitalNotFound} from './access-policy.js';
import type {FactoryFlowService} from './factory-flow-service.js';

type CommunicationFacts=Pick<FactoryFlowSheet,'orderId'|'preparationId'|'routeSchemaVersion'|'facts'>&{craftSteps?:readonly {stepId:string}[]};
type CommunicationScope={orderId:string;preparationId:string;stepRef:string|null};

/** Project only the original communication facts after the factory-flow
 * reader has checked the caller's access to the original order. No inferred
 * factory, quantities, report conclusions, or cross-step history. */
export function workbenchFactoryCommunication(sheet:CommunicationFacts,scope:CommunicationScope){
 if(sheet.orderId!==scope.orderId||sheet.preparationId!==scope.preparationId)return null;
 const knownSteps=sheet.craftSteps??[];
 if(scope.stepRef===null ? sheet.routeSchemaVersion===2||knownSteps.length>0
    : !knownSteps.some(step=>step.stepId===scope.stepRef))return null;
 return sheet.facts.filter(row=>row.kind==='工艺沟通'&&(
  scope.stepRef!==null ? row.payload.stepRef===scope.stepRef : !Object.hasOwn(row.payload,'stepRef')
 )).map(row=>({factId:row.factId,occurredAt:row.occurredAt,recordedAt:row.recordedAt,actorName:row.actorName,
  supplier:typeof row.payload.supplier==='string'&&row.payload.supplier.trim()?row.payload.supplier:null,
  note:typeof row.payload.note==='string'?row.payload.note:null,
 }));
}

/** From one original authorized snapshot, bind the chosen task and scope
 * before returning notes. The original logistics command remains the writer. */
export async function readWorkbenchFactoryCommunication(service:Pick<FactoryFlowService,'read'>,actor:TrustedActorContext,
 scope:CommunicationScope&{taskId:string}){
 const sheet=await service.read(actor,scope.orderId);
 const facts=workbenchFactoryCommunication(sheet,scope);
 const task=sheet.tasks.find(item=>item.taskId===scope.taskId&&item.orderId===scope.orderId&&item.taskKind==='process_logistics'&&
  (item.stepRef??null)===scope.stepRef);
 if(!task||!facts)return digitalNotFound();
 return {scope,expectedRevision:sheet.revision,canRecord:task.canExecute&&task.state==='ready'&&!task.paused&&!sheet.dispatched,facts};
}
