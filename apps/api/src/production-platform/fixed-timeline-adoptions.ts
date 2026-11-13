import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {validateBusinessTime,type BusinessTime,type BusinessTimeScope} from '@dx-rework/domain/business-clock';
import type {SlaAnchor,SlaPlan} from '@dx-rework/domain/digital-sla-plan';
import {validateDigitalSlaSnapshot,type DigitalSlaSnapshot} from '@dx-rework/contracts/digital-sla';
import {SlaVersionConflict} from './sla-configuration-repository.js';
import type {FixedTimelineWork,FixedTimelineTarget} from './fixed-timeline-targets.js';
import {fixedConsumerTargets} from './fixed-consumer-targets.js';
import {canonicalTimelineInput as canonical,fixedTimelineIdentity} from './fixed-timeline-identity.js';
import {readInitialTimelineInput} from './fixed-timeline-initial-input.js';
import type {CraftStepChoice} from '@dx-rework/contracts/digital-craft';
import {buildFixedOrderRouteTargets} from './fixed-order-route-targets.js';
import {FrozenOrderTimePlanSchema,type FrozenOrderTimePlan} from '@dx-rework/contracts/order-time-plan';
import {OrderTimePlanRepository} from './order-time-plan-repository.js';
export {fixedTimelineIdentity} from './fixed-timeline-identity.js';

export type FixedTimelineConsumer={scopeRef:string;lineId:string|null;nodeIds:string[];ends:Record<string,SlaAnchor>;customerGoalIds?:string[];customerDateVersion?:number;
 shipSample?:{nodeId:string;productionNodeId:string;customerGoalId:string;advanceDays:number|null}};
export type FixedTimelineInput={
 timelineSchemaVersion:2;routeSchemaVersion:2;calculationVersion:'fixed-backward-v1'|'fixed-backward-v2';
 resource:BusinessTimeScope;round:number;
 originalPlan:{ref:string;revision:number;plan:SlaPlan};
 unified:{snapshotRef:string;values:DigitalSlaSnapshot};
 development:{snapshotRef:string;version:number;values:Record<string,unknown>}|null;
 sourceVersions:Record<string,string|number>;
 work:Array<FixedTimelineWork&{canonicalWorkRef:string;planningParameterRef:string|null;responsibilitySlaRef:string|null;responsibilityMinutes?:number|null;responsibilityCalendar?:FixedTimelineWork['calendar'];parameterKey?:string;stage?:number;craftStep?:CraftStepChoice;accountingRole?:'original_work'|'added_work'|'included'|'event'|'shared_reference'}>;
 consumers:FixedTimelineConsumer[];
 craftSteps?:Array<CraftStepChoice&{stepId:string}>;
 route?:Array<{kind:string;position:number;nodeId:string;stepId?:string;phase?:'dispatch'|'work'|'confirmation'|'logistics'|'qc'}>;
 orderTimePlan?:FrozenOrderTimePlan;
};
export type FixedTimelineAdoption={adoptionId:string;identityHash:string;input:FixedTimelineInput;time:BusinessTime;creationEventRef:string;createdBy:string};
type AdoptionRow={adoption_id:string;timeline_schema_version:number;route_schema_version:number;input_snapshot:FixedTimelineInput;identity_hash:string;business_time:BusinessTime;creation_event_ref:string;created_by:string};
type DB=Pick<PoolClient,'query'>;
export {fixedConsumerTargets} from './fixed-consumer-targets.js';
function adoption(row:AdoptionRow):FixedTimelineAdoption{
 const input=row.input_snapshot as FixedTimelineInput;
 if(row.timeline_schema_version!==2||row.route_schema_version!==2||input.timelineSchemaVersion!==2||input.routeSchemaVersion!==2
  ||input.calculationVersion!==(input.orderTimePlan?'fixed-backward-v2':'fixed-backward-v1'))throw Error('此订单已采用的计划版本不受当前程序支持');
 if(input.orderTimePlan)FrozenOrderTimePlanSchema.parse(input.orderTimePlan);
 if(fixedTimelineIdentity(input)!==row.identity_hash)throw Error('冻结计划输入校验失败');
 return {adoptionId:row.adoption_id,identityHash:row.identity_hash,input,time:validateBusinessTime(row.business_time),creationEventRef:row.creation_event_ref,createdBy:row.created_by};
}

/** Internal original-command adapter. Caller owns authorization/transaction;
 * this module never reads today's settings to retry an existing adoption.
 */
export class FixedTimelineAdoptionRepository{
 constructor(private readonly db:DB){}
 async available(){return Boolean((await this.db.query("SELECT to_regclass('digital_timeline_adoptions') AS relation")).rows[0]?.relation);}
 async existing(resource:BusinessTimeScope,round?:number):Promise<FixedTimelineAdoption|null>{
  if(!await this.available())return null;
  const rows=(await this.db.query(`SELECT * FROM digital_timeline_adoptions WHERE resource_kind=$1
   AND ${resource.kind==='order'?'production_order_id':'source_id'}=$2 ${resource.kind==='source'&&round!==undefined?'AND round_number=$3':''}
   ORDER BY round_number DESC LIMIT 1`,resource.kind==='source'&&round!==undefined?[resource.kind,resource.id,round]:[resource.kind,resource.id])).rows;
  return rows[0]?adoption(rows[0]):null;
 }
 async capture(resource:BusinessTimeScope,round:number,actorId:string,eventRef:string,time:BusinessTime,newAdoption:'legacy'|'fixed_v2',capture:(inherited:FixedTimelineAdoption|null)=>Promise<FixedTimelineInput>):Promise<FixedTimelineAdoption|null>{
  const prior=await this.existing(resource,round);if(prior)return prior;
  const inherited=resource.kind==='source'?await this.existing(resource):null;
  if(newAdoption==='legacy'&&!inherited)return null;
  if(inherited&&inherited.input.round>=round)throw Error('不能补造历史轮次采用');
  if(!await this.available())throw Error('新计划采用所需迁移尚未完成');
  validateBusinessTime(time);
  await this.db.query(`SELECT ${resource.kind==='order'?'production_order_id':'source_id'} FROM ${resource.kind==='order'?'digital_production_orders':'digital_production_sources'} WHERE ${resource.kind==='order'?'production_order_id':'source_id'}=$1 FOR UPDATE`,[resource.id]);
  const concurrent=await this.existing(resource,round);if(concurrent)return concurrent;
  const input=structuredClone(await capture(inherited));
  if(input.timelineSchemaVersion!==2||input.routeSchemaVersion!==2||input.calculationVersion!==(input.orderTimePlan?'fixed-backward-v2':'fixed-backward-v1')||input.resource.kind!==resource.kind||input.resource.id!==resource.id||input.round!==round||!eventRef.trim())throw Error('采用输入与原业务范围不一致');
  if(input.orderTimePlan)FrozenOrderTimePlanSchema.parse(input.orderTimePlan);
  validateDigitalSlaSnapshot(input.unified.values);
  if(inherited&&(JSON.stringify(canonical(input.unified))!==JSON.stringify(canonical(inherited.input.unified))
   ||JSON.stringify(canonical(input.development))!==JSON.stringify(canonical(inherited.input.development))))throw Error('已有开发来源的新轮次须沿原冻结标准');
  if(inherited&&fixedTimelineIdentity(input.orderTimePlan?.company??null)!==fixedTimelineIdentity(inherited.input.orderTimePlan?.company??null))throw Error('新轮次不能替换本单原公司标准');
  if(!input.originalPlan.ref||!Number.isSafeInteger(input.originalPlan.revision)||input.originalPlan.revision<1||!input.unified.snapshotRef||!input.consumers.length||new Set(input.consumers.map(scope=>scope.scopeRef)).size!==input.consumers.length)throw Error('采用输入缺少原冻结计划或唯一交付开发范围');
  for(const consumer of input.consumers){
   if(!consumer.scopeRef.trim()||!consumer.nodeIds.length||new Set(consumer.nodeIds).size!==consumer.nodeIds.length||resource.kind==='source'&&consumer.lineId!==null)throw Error('采用范围身份无效');
   if(resource.kind==='order'&&(!consumer.lineId||!(await this.db.query('SELECT 1 FROM digital_production_po_lines WHERE production_order_id=$1 AND line_id=$2',[resource.id,consumer.lineId])).rowCount))throw Error('交付范围不属于当前订单PO');
   if(resource.kind==='order'&&(!Number.isSafeInteger(consumer.customerDateVersion)||consumer.customerDateVersion!<0||!consumer.customerGoalIds?.length
    ||consumer.customerGoalIds.some(id=>!consumer.nodeIds.includes(id)||!['date','unknown'].includes(consumer.ends[id]?.precision??''))))throw Error('交付范围缺少原客户交期版本及目标身份');
  }
  const identityHash=fixedTimelineIdentity(input);
  const row=(await this.db.query(`INSERT INTO digital_timeline_adoptions(adoption_id,resource_kind,source_id,production_order_id,round_number,input_snapshot,identity_hash,creation_event_ref,business_time,created_by)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,[randomUUID(),resource.kind,resource.kind==='source'?resource.id:null,resource.kind==='order'?resource.id:null,round,JSON.stringify(input),identityHash,eventRef,JSON.stringify(time),actorId])).rows[0];
  return adoption(row);
 }
 /** Read the captured version even if the deployment stops adopting new v2. */
 async mode(resource:BusinessTimeScope):Promise<'legacy'|'fixed_v2'>{return await this.existing(resource)||await readInitialTimelineInput(this.db,resource)||await new OrderTimePlanRepository(this.db).current(resource)?'fixed_v2':'legacy';}
 async buildInitialTargets(saved:FixedTimelineAdoption,actorId:string,time:BusinessTime){
  validateBusinessTime(time);
  const stored=await this.existing(saved.input.resource,saved.input.round);
  if(!stored||stored.adoptionId!==saved.adoptionId||stored.identityHash!==saved.identityHash)throw Error('冻结采用身份已变化');
  const result:Array<{scopeRef:string;targets:FixedTimelineTarget[]}>=[];
  for(const consumer of stored.input.consumers){
   const previous=(await this.db.query('SELECT targets_json FROM digital_timeline_target_revisions WHERE adoption_id=$1 AND scope_ref=$2 ORDER BY revision LIMIT 1',[stored.adoptionId,consumer.scopeRef])).rows[0];
   if(previous){result.push({scopeRef:consumer.scopeRef,targets:previous.targets_json});continue;}
   const nodes=stored.input.work.filter(node=>consumer.nodeIds.includes(node.id));
   if(nodes.length!==consumer.nodeIds.length)throw Error('冻结范围缺少原适用工作');
   const targets=fixedConsumerTargets(nodes,consumer);
   await this.db.query(`INSERT INTO digital_timeline_target_revisions(target_revision_id,adoption_id,identity_hash,scope_ref,line_id,revision,change_kind,goal_anchor,targets_json,source_event_ref,created_by,business_time,request_key)
    VALUES($1,$2,$3,$4,$5,1,'initial',$6,$7,$8,$9,$10,$11) ON CONFLICT(adoption_id,scope_ref,revision) DO NOTHING`,
    [randomUUID(),stored.adoptionId,stored.identityHash,consumer.scopeRef,consumer.lineId,JSON.stringify(consumer.ends),JSON.stringify(targets),stored.creationEventRef,stored.createdBy,JSON.stringify(stored.time),randomUUID()]);
   const current=(await this.db.query('SELECT identity_hash,targets_json FROM digital_timeline_target_revisions WHERE adoption_id=$1 AND scope_ref=$2 AND revision=1',[stored.adoptionId,consumer.scopeRef])).rows[0];
   if(current.identity_hash!==stored.identityHash||JSON.stringify(canonical(current.targets_json))!==JSON.stringify(canonical(targets)))throw new SlaVersionConflict('固定目标与原采用输入不一致');
   result.push({scopeRef:consumer.scopeRef,targets:current.targets_json});
  }
  return result;
 }
 /** B0 is restored first. Only the original approved, genuinely changed customer
  * date events can append Bk; ordinary plan revisions, factory F and now cannot.
  * The existing native date log and original plan BusinessTime are sufficient:
  * no second event source or re-reading today's standards is introduced.
  */
 async buildPendingTargets(saved:FixedTimelineAdoption){
  await this.db.query('SELECT adoption_id FROM digital_timeline_adoptions WHERE adoption_id=$1 FOR UPDATE',[saved.adoptionId]);
  await this.buildInitialTargets(saved,saved.createdBy,saved.time);
  if(saved.input.resource.kind!=='order')return;
  // The first physical route may be published after a legitimate H change.
  // Replay starts from the original creation snapshot, not that later route's
  // capture time; otherwise the original B0 can never advance to the real H.
  const initial=await readInitialTimelineInput(this.db,saved.input.resource);
  const earliest=initial?.data.time??saved.time;
  if(earliest.scenarioId!==saved.time.scenarioId||Date.parse(earliest.now)>Date.parse(saved.time.now))throw Error('原订单采用与路线时钟范围不一致');
  for(const consumer of saved.input.consumers){
   const changes=(await this.db.query(`SELECT c.change_id,c.version,c.old_date::text AS old_date,c.new_date::text AS new_date,c.approval_event_id,c.changed_by,p.business_time
    FROM digital_po_date_changes c JOIN digital_sla_plans p ON p.production_order_id=c.production_order_id AND p.request_key=c.approval_event_id
    WHERE c.production_order_id=$1 AND c.line_id=$2 AND c.date_kind='customer' AND c.source='approved_customer_change'
      AND c.version>$3 AND c.old_date IS DISTINCT FROM c.new_date ORDER BY c.version`,[saved.input.resource.id,consumer.lineId,consumer.customerDateVersion])).rows;
   let previousGoals=structuredClone(consumer.ends);
   for(const change of changes){
    const time=validateBusinessTime(change.business_time);
    if(time.scenarioId!==earliest.scenarioId||Date.parse(time.now)<Date.parse(earliest.now))throw Error('客户改期与原冻结时钟范围不一致');
    const goals=structuredClone(previousGoals);
    for(const id of consumer.customerGoalIds!){
     const prior=goals[id]!;
     if(prior.precision==='date'?prior.value!==change.old_date:prior.precision!=='unknown'||change.old_date!==null)throw Error('客户交期有效版本链不连续');
     goals[id]={precision:'date',value:change.new_date,source:`digital_po_date_changes:${change.change_id}`};
    }
    previousGoals=goals;
    const eventRef=`digital_po_date_changes:${change.change_id}`;
    if((await this.db.query('SELECT 1 FROM digital_timeline_target_revisions WHERE adoption_id=$1 AND scope_ref=$2 AND source_event_ref=$3',[saved.adoptionId,consumer.scopeRef,eventRef])).rowCount)continue;
    const targets=fixedConsumerTargets(saved.input.work.filter(node=>consumer.nodeIds.includes(node.id)),consumer,goals);
    await this.db.query(`INSERT INTO digital_timeline_target_revisions(target_revision_id,adoption_id,identity_hash,scope_ref,line_id,revision,change_kind,goal_anchor,targets_json,source_event_ref,created_by,business_time,request_key)
     SELECT $1,$2,$3,$4,$5,max(revision)+1,'customer_date_change',$6,$7,$8,$9,$10,$11 FROM digital_timeline_target_revisions
     WHERE adoption_id=$2 AND scope_ref=$4`,[randomUUID(),saved.adoptionId,saved.identityHash,consumer.scopeRef,consumer.lineId,JSON.stringify(goals),JSON.stringify(targets),eventRef,change.changed_by,JSON.stringify(time),change.change_id]);
   }
  }
  await buildFixedOrderRouteTargets(this.db,saved);
 }
 /** Original authorized readers own the caller's snapshot and field policy. */
 async currentTargets(resource:BusinessTimeScope,round?:number){
  const saved=await this.existing(resource,round);if(!saved)return null;
  const rows=(await this.db.query(`SELECT DISTINCT ON(scope_ref) scope_ref,line_id,revision,goal_anchor,targets_json,source_event_ref,business_time
   FROM digital_timeline_target_revisions WHERE adoption_id=$1 ORDER BY scope_ref,revision DESC`,[saved.adoptionId])).rows;
  return {adoption:saved,scopes:rows};
 }
}
