import type {DevelopmentSampleHandover} from '@dx-rework/contracts/digital-development-workspace';
import type {PreparationDB} from './preparation-material-repository.js';

const electronicKinds=['materials','order_quantities','quotation'] as const;

export async function formalDevelopmentHandoverAvailable(db:PreparationDB){
 return Boolean((await db.query("SELECT to_regclass('digital_development_formal_handover_enrollments') AS relation")).rows[0]?.relation);
}

/** Called once in the native formal creation transaction, never on adoption of an old order. */
export async function enrollFormalDevelopmentHandover(db:PreparationDB,orderId:string,sourceId:string,creationEventId:string){
 if(!await formalDevelopmentHandoverAvailable(db))return;
 await db.query('INSERT INTO digital_development_formal_handover_enrollments(production_order_id,source_id,creation_event_id) VALUES($1,$2,$3)',[orderId,sourceId,creationEventId]);
}

export async function formalDevelopmentHandoverEnrollment(db:PreparationDB,orderId:string|null,sourceId:string|null){
 if(!orderId||!sourceId||!await formalDevelopmentHandoverAvailable(db))return null;
 return (await db.query<{creation_event_id:string}>(`SELECT creation_event_id FROM digital_development_formal_handover_enrollments
  WHERE production_order_id=$1 AND source_id=$2`,[orderId,sourceId])).rows[0]?.creation_event_id??null;
}

/** Combines already scoped, original facts. It does not confer access or start a clock. */
export function formalDevelopmentHandoverEvidence(view:DevelopmentSampleHandover,formalOrigin:{at:string;evidence:string}|null){
 const recipientId=view.recipient?.id;
 const sample=view.current;
 if(!formalOrigin||!recipientId||!sample||sample.round!==view.round||sample.documentVersion!==view.documentVersion||sample.recipientId!==recipientId)return null;
 const electronic=electronicKinds.flatMap(kind=>{
  const matches=view.electronic.filter(value=>value.kind===kind);
  const item=matches[0];
  return matches.length===1&&item?.state==='shared'&&item.receipt?.recipientId===recipientId?[{kind,...item.receipt}]:[];
 });
 if(electronic.length!==electronicKinds.length)return null;
 const times=[...electronic.map(receipt=>Date.parse(receipt.at)),Date.parse(sample.occurredAt)];
 const formalStart=Date.parse(formalOrigin.at);
 if(!Number.isFinite(formalStart)||times.some(time=>!Number.isFinite(time)))return null;
 const satisfiedAt=Math.max(...times);
 return {sourceId:view.sourceId,round:view.round,documentVersion:view.documentVersion,recipientId,
  satisfiedAt:new Date(satisfiedAt).toISOString(),assessmentEligibleAt:new Date(Math.max(formalStart,satisfiedAt)).toISOString(),
  formalOrigin:formalOrigin.evidence,receipts:electronic,sampleReceiptId:sample.eventId};
}
