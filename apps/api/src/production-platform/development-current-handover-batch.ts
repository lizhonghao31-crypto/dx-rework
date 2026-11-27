import type {PoolClient} from 'pg';
import type {DevelopmentDocument} from '@dx-rework/contracts/digital-development';
import type {DevelopmentSampleHandoverReceipt} from '@dx-rework/contracts/digital-development-workspace';
import {validateBusinessTime,type BusinessTime} from '@dx-rework/domain/business-clock';
import type {TrustedActorContext} from '../tools/repositories.js';
import {acceptanceBusinessContext} from '../acceptance-clock/business-time.js';
import {isRootActor} from '../access/business-authority.js';
import {ApplicationError} from '../platform/errors.js';
import {developmentReadTables} from './development-amendment-repository.js';
import {developmentRoundsAvailable} from './development-round-repository.js';
import {readJourneySelectionAccess} from './journey-selection-access.js';
import {currentFormalPreparationHandovers} from './preparation-material-repository.js';
import {hasQuotationSchema} from './quotation-budget-basis.js';
import {formalDevelopmentHandoverEvidence} from './development-formal-handover-evidence.js';
import {DEVELOPMENT_HANDOVER_ENTITY,ELECTRONIC_HANDOVER_EVENT,SAMPLE_HANDOVER_EVENT,designElectronicBasesFromFacts,effectiveElectronicHandover,
 projectDesignElectronicHandover,type ElectronicEvent,type ElectronicQuantityRow,type ElectronicQuoteRow} from './development-electronic-handover.js';

type Pair={sourceId:string;orderId:string};
type MaterialDocument=Pick<DevelopmentDocument,'materials'>;
type State=Pair&{recipientId:string;version:number;round_number:number;document:MaterialDocument;orderVersion:number;
 sample:{id:string;payload:Omit<DevelopmentSampleHandoverReceipt,'eventId'|'confirmedByName'|'confirmedBy'>;actorId:string};
 createdBusinessTime:BusinessTime;creationEventRef:string|null};

function groupByOrder<T extends {orderId:string}>(rows:readonly T[]):Map<string,Omit<T,'orderId'>[]>{
 const grouped=new Map<string,Omit<T,'orderId'>[]>();
 for(const {orderId,...row} of rows){const entries=grouped.get(orderId)??[];entries.push(row);grouped.set(orderId,entries);}
 return grouped;
}

/** A list-only proof, not a second handover definition. The caller has
 * selected authorized roots with an original completed event. Recheck the
 * original source/order/recipient permissions and use the same pure receipt
 * and material projections as the detail path in the same RR snapshot. */
export async function readCurrentFormalHandovers(db:PoolClient,actor:TrustedActorContext,pairs:readonly Pair[]){
 const complete=new Set<string>();
 if(!pairs.length)return complete;
 const access=await readJourneySelectionAccess(db,actor,pairs.map(({orderId})=>({kind:'order',id:orderId})));
 const allowed=pairs.filter(pair=>access.resources.get(`order:${pair.orderId}`)?.technical);
 if(!allowed.length)return complete;
 const role=(name:string)=>actor.actorRoles.includes(name)&&access.liveRoles.has(name);
 const leader=isRootActor(actor)||role('owner_group')||role('production_management');
 const tables=await developmentReadTables(db),rounds=await developmentRoundsAvailable(db);
 const rows=(await db.query<State>(`WITH selected AS (
  SELECT * FROM jsonb_to_recordset($1::jsonb) AS pair("orderId" uuid,"sourceId" uuid)
 ), current_documents AS (
  SELECT pair.*,o.primary_merchandiser_id AS "recipientId",o.version AS "orderVersion",
   ${rounds?'coalesce(r.round_number,1)':'1'} AS round_number,
   ${rounds?'coalesce(r.document_version,d.version)':'d.version'} AS version,
   jsonb_build_object('materials',${rounds?'coalesce(r.document,d.document)':'d.document'}->'materials') AS document
  FROM selected pair JOIN digital_production_orders o ON o.production_order_id=pair."orderId" AND o.source_id=pair."sourceId"
  JOIN digital_production_sources s ON s.source_id=pair."sourceId"
  JOIN ${tables.documents} d ON d.source_id=s.source_id AND d.status='published'
  ${rounds?`LEFT JOIN LATERAL(SELECT rr.round_number,rr.document_version,rr.document FROM ${tables.rounds} rr
   WHERE rr.source_id=s.source_id ORDER BY rr.round_number DESC LIMIT 1) r ON true`:''}
  WHERE ($2::boolean OR ($3::boolean AND s.created_by=$4) OR ($5::boolean AND o.primary_merchandiser_id=$4))
   AND EXISTS(SELECT 1 FROM app_users recipient JOIN user_role_assignments a ON a.user_id=recipient.id AND a.revoked_at IS NULL
    JOIN business_roles role ON role.role_code=a.role_code AND role.enabled
    WHERE recipient.id=o.primary_merchandiser_id AND recipient.enabled AND a.role_code='order_merchandiser'
     AND NOT coalesce((to_jsonb(recipient)->>'manual_access_disabled')::boolean,false)
     AND EXISTS(SELECT 1 FROM identity_mappings i WHERE i.user_id=recipient.id AND i.active AND i.employed))
 )
 SELECT fact.*,jsonb_build_object('id',sample.id,'payload',sample.after_state,'actorId',sample.actor_id) AS sample,
  origin.created_business_time AS "createdBusinessTime",origin.creation_event_ref AS "creationEventRef"
 FROM current_documents fact
 JOIN digital_order_time_subjects origin ON origin.resource_kind='order' AND origin.production_order_id=fact."orderId"
 JOIN LATERAL(SELECT e.id,e.after_state,e.actor_id FROM audit_events e
  WHERE e.entity_type=$6 AND e.action=$7 AND e.entity_id=fact."sourceId"::text
   AND e.after_state->>'round'=fact.round_number::text AND e.after_state->'documentVersion'=to_jsonb(fact.version)
   AND e.after_state->>'recipientId'=fact."recipientId"::text
  ORDER BY e.created_at DESC,e.id DESC LIMIT 1) sample ON true`,
  [JSON.stringify(allowed),leader,role('sample_designer'),actor.actorId,role('order_merchandiser'),DEVELOPMENT_HANDOVER_ENTITY,SAMPLE_HANDOVER_EVENT])).rows;
 const context=acceptanceBusinessContext();
 const scoped:State[]=[];
 for(const row of rows){
  if(context){
   if(!await context.acceptsActor(row.recipientId))continue;
   try{await context.assertScope({kind:'source',id:row.sourceId});}
   catch(error){if(error instanceof ApplicationError&&[403,404].includes(error.statusCode))continue;throw error;}
  }
  scoped.push(row);
 }
 const originalPreparations=await currentFormalPreparationHandovers(db,scoped);
 const ready=scoped.flatMap(row=>{
  const scope={sourceId:row.sourceId,round:row.round_number,recipientId:row.recipientId};
  const handover=effectiveElectronicHandover(scope,originalPreparations.get(row.orderId));
  return handover?[{row,scope,handover}]:[];
 });
 if(!ready.length)return complete;
 const binding=JSON.stringify(ready.map(({row,scope,handover})=>({...scope,orderId:row.orderId,originalVersion:handover.sourceDocumentVersion??null})));
 const records=`WITH selected AS(SELECT * FROM jsonb_to_recordset($1::jsonb) AS pair("orderId" uuid,"sourceId" uuid,
  "recipientId" uuid,round integer,"originalVersion" integer))`;
 const quantities=(await db.query<ElectronicQuantityRow&{orderId:string}>(`${records} SELECT pair."orderId",p.line_id,p.po_number,p.color,s.size,s.quantity
   FROM selected pair JOIN digital_production_po_lines p ON p.production_order_id=pair."orderId"
   LEFT JOIN digital_production_po_sizes s USING(line_id) ORDER BY pair."orderId",p.line_id,s.size COLLATE "C"`,[binding])).rows;
 const quotes=await hasQuotationSchema(db)?(await db.query<ElectronicQuoteRow&{orderId:string}>(`${records}
   SELECT pair."orderId",d.quote_id,v.version FROM selected pair JOIN digital_production_orders o ON o.production_order_id=pair."orderId"
   JOIN digital_quotation_documents d ON d.production_order_id=o.production_order_id
    AND d.version=d.confirmed_version AND (d.source_id=pair."sourceId" OR d.source_id IS NULL)
   JOIN digital_quotation_versions v ON v.quote_id=d.quote_id AND v.version=d.confirmed_version AND v.customer_code=o.customer_code`,[binding])).rows:[];
 const events=(await db.query<ElectronicEvent&{orderId:string}>(`${records} SELECT pair."orderId",e.id,e.after_state
   FROM selected pair JOIN audit_events e ON e.entity_id=pair."sourceId"::text AND e.entity_type=$2 AND e.action=$3
    AND e.after_state->>'round'=pair.round::text AND e.after_state->>'recipientId'=pair."recipientId"::text
   ORDER BY pair."orderId",e.created_at DESC,e.id DESC`,[binding,DEVELOPMENT_HANDOVER_ENTITY,ELECTRONIC_HANDOVER_EVENT])).rows;
 const prior=(await db.query<{orderId:string;document:MaterialDocument}>(`${records}
   SELECT pair."orderId",jsonb_build_object('materials',d.document->'materials') AS document
    FROM selected pair JOIN digital_development_documents d ON d.source_id=pair."sourceId" AND pair.round=1
     AND d.version=pair."originalVersion" AND d.status='published'
   ${rounds?`UNION ALL SELECT pair."orderId",jsonb_build_object('materials',r.document->'materials')
    FROM selected pair JOIN digital_development_rounds r ON r.source_id=pair."sourceId" AND r.round_number=pair.round AND r.document_version=pair."originalVersion"`:''}
   ${tables.amended?`UNION ALL SELECT pair."orderId",jsonb_build_object('materials',a.document->'materials')
    FROM selected pair JOIN digital_development_amendments a ON a.source_id=pair."sourceId" AND a.round_number=pair.round AND a.document_version=pair."originalVersion"`:''}`,[binding])).rows;
 const quantityByOrder=groupByOrder(quantities),quoteByOrder=groupByOrder(quotes),eventByOrder=groupByOrder(events),priorByOrder=groupByOrder(prior);
 for(const {row,scope,handover} of ready){
  const prior=priorByOrder.get(row.orderId)??[];
  if(prior.length>1)throw new Error('开发单所选轮次与资料版本存在冲突，未读取其他版本');
  const bases=designElectronicBasesFromFacts(row.sourceId,row,{id:row.orderId,version:row.orderVersion},
   quantityByOrder.get(row.orderId)??[],quoteByOrder.get(row.orderId)??[]);
  const electronic=projectDesignElectronicHandover(scope,bases,handover,'available',eventByOrder.get(row.orderId)??[],prior[0]?.document);
  const sample={eventId:row.sample.id,...row.sample.payload,confirmedBy:row.sample.actorId,confirmedByName:null};
  const origin={at:validateBusinessTime(row.createdBusinessTime).now,evidence:String(row.creationEventRef)};
  if(formalDevelopmentHandoverEvidence({sourceId:row.sourceId,round:row.round_number,documentVersion:row.version,
   recipient:{id:row.recipientId,name:null},current:sample,canConfirm:false,electronic,history:[]},origin))complete.add(row.orderId);
 }
 return complete;
}
