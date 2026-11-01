import type {preparationContext} from './preparation-material-repository.js';
import {randomUUID} from 'node:crypto';
import {ApplicationError} from '../platform/errors.js';
import {businessNow,acceptanceBusinessContext} from '../acceptance-clock/business-time.js';
import {appendSeriesSourceEvent} from './series-plan-facts.js';
import {preparationAvailable,currentPreparationMaterials,preparationMaterialHistory,type PreparationDB} from './preparation-material-repository.js';
export async function bridgePreparationMaterials(db:PreparationDB,context:Awaited<ReturnType<typeof preparationContext>>,actorId:string){
 if(!context.orderId||!await preparationAvailable(db))return;
 if(!(await db.query("SELECT to_regclass('digital_series_source_events') AS relation")).rows[0]?.relation)return;
 const materials=currentPreparationMaterials(await preparationMaterialHistory(db,context),context.orderId);
 for(const fact of materials){
  const prior=(await db.query('SELECT * FROM digital_series_source_events WHERE production_order_id=$1 AND node_key=$2 AND scope_ref=$3 ORDER BY source_version DESC LIMIT 1',[context.orderId,fact.kind,fact.scopeRef])).rows[0];
  if(prior&&prior.source_record_id!==fact.recordId)throw new ApplicationError('PREPARATION_CONFLICT','该节点排程已引用另一原始记录，请核对来源；本次物料记录未写入',409);
  if(prior&&prior.source_version>=fact.version)continue;
  const known=['ready','partial'].includes(fact.state)&&fact.valid&&Boolean(fact.occurredAt);
  await appendSeriesSourceEvent(db,{eventId:randomUUID(),orderId:context.orderId,key:fact.kind,scopeRef:fact.scopeRef,sourceDomain:'bulk-preparation',sourceRecordId:fact.recordId,sourceVersion:fact.version,
   occurredAt:known?fact.occurredAt:null,occurredDate:null,precision:known?'instant':'unknown',supersedesEventId:prior?.event_id??null,
   voided:!known,businessCompleted:fact.state==='ready',reason:fact.note},actorId,{now:businessNow().toISOString(),scenarioId:acceptanceBusinessContext()?.scenarioId??null});
 }
}

