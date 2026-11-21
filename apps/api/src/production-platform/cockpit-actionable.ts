import {readJourneyCandidateCohort} from './journey-snapshot-reads.js';
import type {Pool,PoolClient} from 'pg';
import type {CockpitActionableTodo} from '@dx-rework/contracts/digital-production-journey';
import {instructionErrors,instructionMatchesTechnicalSizes,type InstructionDocument} from '@dx-rework/contracts/production-instruction';
import {publishedTechnicalArtifact} from './development-technical-repository.js';
import {preparationSupplement} from './preparation-todos.js';
import type {DevelopmentMaterial} from '@dx-rework/contracts/digital-development';
import type {PreparationMaterialFact} from '@dx-rework/contracts/production-readiness';
import {preparationHandoverCurrent,preparationInvestmentComplete,preparationResponsibility,instructionInvestmentMaterials} from './preparation-material-repository.js';
import {DigitalProductionAccessPolicy} from './access-policy.js';
import {productionReadiness} from './production-readiness-repository.js';
import {acceptsNewOrderTime} from './order-time-admission.js';
import {preparationMaterialLabels} from '@dx-rework/contracts/production-readiness';
import {developmentReadTables} from './development-amendment-repository.js';
import {acceptanceBusinessContext,ContextBusinessClock} from '../acceptance-clock/business-time.js';
import {loadOrderTimeOperation} from './order-time-operation-state.js';
import {materialReadiness} from './development-material-readiness.js';
import {developmentDocumentRow} from './development-round-repository.js';
import {validateSpecialCraftChoices} from './special-craft-library.js';
import {ApplicationError} from '../platform/errors.js';
import type {TrustedActorContext} from '../tools/repositories.js';

type Candidate={id:string;orderId:string;asOf:string};
type OwnerApproval={orderId:string;caseId:string;decisionId:string;handlerId:string;primaryId:string|null};

export async function readCockpitOwnerApprovals(db:PoolClient,candidates:readonly Candidate[]){
 const result=new Map<string,CockpitActionableTodo['items']>();
 if(!candidates.length)return result;
 const rows=(await db.query<OwnerApproval>(`SELECT candidate.id AS "orderId",source.sourcing_case_id AS "caseId",
  decision.sourcing_decision_id AS "decisionId",todo.recipient_user_id AS "handlerId",mother.primary_merchandiser_id AS "primaryId"
  FROM jsonb_to_recordset($1::jsonb) AS candidate(id uuid,"orderId" uuid,"asOf" timestamptz)
  JOIN digital_production_orders mother ON mother.production_order_id=candidate."orderId"
  JOIN digital_production_child_links l ON l.production_order_id=mother.production_order_id AND l.module='sourcing'
  JOIN sourcing_cases source ON source.sourcing_case_id=l.child_id AND source.deleted_at IS NULL
  JOIN current_sourcing_cases current ON current.sourcing_case_id=source.sourcing_case_id AND current.status='pending_owner_approval'
  JOIN LATERAL(SELECT d.sourcing_decision_id,d.decision_version FROM sourcing_decisions d WHERE d.sourcing_case_id=source.sourcing_case_id
    ORDER BY decision_version DESC LIMIT 1) decision ON true
  JOIN rework_todos todo ON todo.entity_type='sourcing_case' AND todo.entity_id=source.sourcing_case_id::text
   AND todo.category='sourcing_owner_approval' AND todo.todo_type='business_action' AND todo.status='pending'
   AND todo.required_role='owner_group' AND todo.required_capability='sourcing:owner:approve'
   AND todo.route_descriptor->>'routeName'='sourcing_detail' AND todo.route_descriptor->>'entityId'=source.sourcing_case_id::text
   AND todo.dedupe_key='sourcing:'||source.sourcing_case_id::text||':owner:'||decision.decision_version||':'||todo.recipient_user_id::text
  JOIN operation_events origin ON origin.event_id=todo.source_event_id
   AND coalesce((origin.after_state->'acceptanceClock'->>'now')::timestamptz,origin.created_at)<=candidate."asOf"
  LEFT JOIN digital_production_resource_lifecycle lifecycle ON lifecycle.resource_kind='order' AND lifecycle.resource_id=mother.production_order_id
  WHERE coalesce(lifecycle.state,'active')='active'
   AND todo_user_has_direct_role(todo.recipient_user_id,'owner_group','sourcing:owner:approve')
   AND member_module_can_write(todo.recipient_user_id,'sourcing')
   AND (source.workflow_generation<>'digital_production_v1' OR (
    todo_user_has_direct_role(mother.primary_merchandiser_id,'order_merchandiser','sourcing:contract:record')
    AND member_module_can_write(mother.primary_merchandiser_id,'sourcing')))
  ORDER BY candidate.id,source.sourcing_case_id,todo.recipient_user_id`,[JSON.stringify(candidates)])).rows;
 const asOf=new Map(candidates.map(row=>[row.id,row.asOf])),context=acceptanceBusinessContext();
 for(const row of rows){
  if(context&&(!await context.acceptsActor(row.handlerId)||row.primaryId&&!await context.acceptsActor(row.primaryId)))continue;
  const items=result.get(row.orderId)??[];
  if(items.some(item=>item.evidenceId===row.decisionId))continue;
  items.push({orderId:row.orderId,category:'sourcing_owner_approval',evidenceId:row.decisionId,
   missingObject:'选厂老板审批',handlerRole:'owner_group',handlerId:row.handlerId,originalRoute:'/ui/sourcing/orders/'+row.caseId,
   reason:'本次选厂申请已到具备审批权限的负责人',asOf:asOf.get(row.orderId)!});
  result.set(row.orderId,items);
 }
 return result;
}

type MaterialCandidate={id:string;orderId:string|null;sourceId:string|null;asOf:string};
type MaterialBasis={
 id:string;orderId:string|null;sourceId:string|null;round:number;
 enrollmentId:string;sourceVersion:number|null;designer:string|null;merchandiser:string|null;
 materials:DevelopmentMaterial[]|null;instruction:InstructionDocument|null;
 materialInvestment:Pick<PreparationMaterialFact,'state'|'quantities'|'valid'|'investmentMaterialOccurrences'>|null;
 designHandover:(Pick<PreparationMaterialFact,'state'|'sourceDocumentVersion'|'orderInstructionVersion'|'investmentScopeBasis'|'recipientId'|'valid'>&{id:string})|null;
 hasRequiredFabric:boolean;canChooseRecipient:boolean;
};

/** Only include steps that the original published development and material
 * record screens prove can be performed now. Physical arrivals with no
 * verified handoff are normal waits. */
export async function readCockpitMaterialActions(db:PoolClient,candidates:readonly MaterialCandidate[]){
 const items=new Map<string,CockpitActionableTodo['items']>();
 if(!candidates.length)return items;
 const tables=await developmentReadTables(db);
 const rows=(await db.query<MaterialBasis>(`SELECT requested.id,requested."orderId",s.source_id AS "sourceId",
  coalesce(round.round_number,1) AS round,adoption.adoption_id AS "enrollmentId",
  coalesce(round.document_version,d.version,j.version) AS "sourceVersion",
  CASE WHEN designer.id IS NOT NULL THEN s.created_by END AS designer,
  CASE WHEN merch.id IS NOT NULL AND coalesce((to_jsonb(merch)->>'manual_access_disabled')::boolean,false)=false THEN o.primary_merchandiser_id END AS merchandiser,
  coalesce(jsonb_array_length(jsonb_path_query_array(coalesce(round.document,d.document),'$.materials[*] ? (@.category != "辅料" && @.requiredThisRound == true && @.name != "" && @.quantity != "")'))>0,false) AS "hasRequiredFabric",
  coalesce(round.document,d.document)->'materials' AS materials,j.document AS instruction,investment.fact AS "materialInvestment",handover.fact AS "designHandover",
  EXISTS(SELECT 1 FROM user_role_assignments role JOIN business_roles r ON r.role_code=role.role_code AND r.enabled
    JOIN app_users person ON person.id=role.user_id AND person.enabled AND NOT coalesce((to_jsonb(person)->>'manual_access_disabled')::boolean,false)
    JOIN identity_mappings i ON i.user_id=person.id AND i.active AND i.employed
    JOIN identity_mappings creator_identity ON creator_identity.user_id=s.created_by AND creator_identity.active AND creator_identity.employed
      AND creator_identity.provider=i.provider AND creator_identity.corp_id=i.corp_id
    WHERE role.role_code='order_merchandiser' AND role.revoked_at IS NULL) AS "canChooseRecipient"
  FROM jsonb_to_recordset($1::jsonb) AS requested(id uuid,"orderId" uuid,"sourceId" uuid,"asOf" timestamptz)
  LEFT JOIN digital_production_sources s ON s.source_id=requested."sourceId"
  LEFT JOIN digital_production_orders o ON o.production_order_id=requested."orderId" AND o.source_id IS NOT DISTINCT FROM s.source_id
  LEFT JOIN ${tables.documents} d ON d.source_id=s.source_id AND d.status='published'
  LEFT JOIN digital_instruction_documents j ON s.source_id IS NULL AND j.production_order_id=o.production_order_id AND j.version>0
  LEFT JOIN LATERAL (SELECT r.round_number,r.document_version,r.document FROM ${tables.rounds} r WHERE r.source_id=s.source_id ORDER BY r.round_number DESC LIMIT 1) round ON true
  JOIN LATERAL (SELECT a.adoption_id FROM digital_preparation_rule_adoptions a WHERE
    (requested."orderId" IS NULL AND a.resource_kind='source' AND a.resource_id=s.source_id)
    OR (requested."orderId" IS NOT NULL AND a.resource_kind='order' AND a.resource_id=o.production_order_id)
    ORDER BY a.revision DESC LIMIT 1) adoption ON true
  LEFT JOIN app_users designer ON designer.id=s.created_by AND designer.enabled AND NOT coalesce((to_jsonb(designer)->>'manual_access_disabled')::boolean,false)
   AND EXISTS(SELECT 1 FROM user_role_assignments a JOIN business_roles r ON r.role_code=a.role_code AND r.enabled
    WHERE a.user_id=designer.id AND a.role_code='sample_designer' AND a.revoked_at IS NULL)
   AND EXISTS(SELECT 1 FROM identity_mappings m WHERE m.user_id=designer.id AND m.active AND m.employed)
  LEFT JOIN app_users merch ON merch.id=o.primary_merchandiser_id AND merch.enabled
   AND EXISTS(SELECT 1 FROM user_role_assignments a JOIN business_roles r ON r.role_code=a.role_code AND r.enabled
    WHERE a.user_id=merch.id AND a.role_code='order_merchandiser' AND a.revoked_at IS NULL)
   AND EXISTS(SELECT 1 FROM identity_mappings m WHERE m.user_id=merch.id AND m.active AND m.employed)
  LEFT JOIN LATERAL (SELECT jsonb_build_object('state',m.state,'quantities',coalesce(m.body->'quantities','[]'::jsonb),'investmentMaterialOccurrences',m.body->'investmentMaterialOccurrences','valid',
   NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(coalesce(m.body->'evidenceIds','[]'::jsonb)) file(id)
    WHERE NOT EXISTS(SELECT 1 FROM attachments a WHERE a.attachment_id::text=file.id AND a.status='ready'))) AS fact
   FROM digital_preparation_material_versions m WHERE m.kind='material_investment' AND m.scope_ref='whole'
    AND ((m.resource_kind='order' AND m.resource_id=o.production_order_id) OR (m.resource_kind='source' AND m.resource_id=s.source_id))
   ORDER BY (m.resource_kind='order') DESC,m.recorded_at DESC,m.version DESC,m.record_id LIMIT 1) investment ON true
  LEFT JOIN LATERAL (SELECT jsonb_build_object('id',m.record_id,'state',m.state,'sourceDocumentVersion',m.body->'sourceDocumentVersion','orderInstructionVersion',m.body->'orderInstructionVersion','investmentScopeBasis',m.body->'investmentScopeBasis','recipientId',m.body->>'recipientId',
   'valid',NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(coalesce(m.body->'evidenceIds','[]'::jsonb)) file(id)
    WHERE NOT EXISTS(SELECT 1 FROM attachments a WHERE a.attachment_id::text=file.id AND a.status='ready'))) AS fact
   FROM digital_preparation_material_versions m WHERE m.kind='design_handover' AND m.scope_ref='whole'
    AND ((m.resource_kind='order' AND m.resource_id=o.production_order_id) OR (m.resource_kind='source' AND m.resource_id=s.source_id))
   ORDER BY (m.resource_kind='order') DESC,m.recorded_at DESC,m.version DESC,m.record_id LIMIT 1) handover ON true
  WHERE (d.source_id IS NOT NULL OR (s.source_id IS NULL AND o.production_order_id IS NOT NULL))
   AND NOT EXISTS (SELECT 1 FROM digital_order_closures closed WHERE closed.production_order_id=o.production_order_id)
   AND NOT EXISTS (SELECT 1 FROM digital_production_resource_lifecycle l WHERE
    ((l.resource_kind='order' AND l.resource_id=o.production_order_id) OR (l.resource_kind='source' AND l.resource_id=s.source_id)) AND l.state<>'active')
   AND (requested."orderId" IS NOT NULL OR NOT EXISTS(SELECT 1 FROM digital_production_orders linked WHERE linked.source_id=s.source_id))`,
  [JSON.stringify(candidates)])).rows;
 const asOf=new Map(candidates.map(row=>[row.id,row.asOf])),context=acceptanceBusinessContext();
 await readJourneyCandidateCohort(db,rows,async(client,row)=>{
  const collection:CockpitActionableTodo['items']=[];
  const add=(kind:'design_handover'|'material_investment',handlerRole:string,handlerId:string,evidenceId:string,reason:string)=>{
   collection.push({orderId:row.id,category:'preparation_material',evidenceId,handlerRole,handlerId,
    missingObject:preparationMaterialLabels[kind],originalRoute:kind==='material_investment'
      ?`/ui/digital-production?${row.orderId?'materialOrder='+row.orderId:'materialSource='+row.sourceId}&materialKind=material_investment`
      :row.orderId
      ?`/ui/digital-production?bulk=${row.orderId}&materialKind=${kind}`
      :`/ui/digital-production?development=${row.sourceId}&round=${row.round}&materialKind=${kind}`,reason,asOf:asOf.get(row.id)!});
  };
  const handover=row.designHandover;
  const direct=!row.sourceId&&Boolean(row.orderId);
  const document=row.sourceVersion===null?null:{version:row.sourceVersion,
   materials:row.sourceId?row.materials??[]:row.instruction?instructionInvestmentMaterials(row.instruction):[]};
  const currentHandover=handover?.state==='ready'&&handover.valid&&(direct
   ?handover.orderInstructionVersion==null||preparationHandoverCurrent(handover,document,'instruction')
   :preparationHandoverCurrent(handover,document));
  const primary=row.merchandiser&&(!context||await context.acceptsActor(row.merchandiser))?row.merchandiser:null;
  // The native preparation service authorizes a source-only recipient by the
  // effective handover and a still-active merchandiser role.
  const sourceRecipient=!row.orderId&&currentHandover?handover.recipientId:null;
  const recipient=row.orderId?primary:sourceRecipient&&await new DigitalProductionAccessPolicy(client).activeRole(sourceRecipient,'order_merchandiser')?sourceRecipient:null;
  const validHandover=currentHandover&&recipient!==null&&(row.orderId!==null||handover.recipientId===recipient);
  const canHandover=row.orderId?Boolean(primary):row.canChooseRecipient&&!context;
  if(canHandover&&!validHandover&&row.designer&&(!context||await context.acceptsActor(row.designer)))
   add('design_handover','sample_designer',row.designer,row.designHandover?.id??row.enrollmentId,'当前已发布资料尚未有效交接给本单跟单');
  if(recipient&&validHandover&&(row.hasRequiredFabric||direct||Boolean(handover.investmentScopeBasis?.materialIds.length))&&!preparationInvestmentComplete(handover,row.materialInvestment??undefined))
   add('material_investment','order_merchandiser',recipient,row.enrollmentId,'本单已交接当前资料，待跟单按原单记录实际投料');
  items.set(row.id,collection);
 });
 return items;
}

/** A current ready supply task represents a human action. Merely waiting
 * for materials or seeing a planning task does not. */
export async function readCockpitDevelopmentSupply(db:PoolClient,candidates:readonly MaterialCandidate[]){
 const items=new Map<string,CockpitActionableTodo['items']>(),sources=candidates.filter(candidate=>!candidate.orderId&&candidate.sourceId);
 if(!sources.length)return items;
 const rows=(await db.query<{id:string;sourceId:string;taskId:string;round:number;handlerId:string;role:string}>(`SELECT candidate.id,candidate."sourceId",
  task.task_id AS "taskId",task.route_version AS round,original.assignee_id AS "handlerId",original.required_role AS role
  FROM jsonb_to_recordset($1::jsonb) AS candidate(id uuid,"sourceId" uuid)
  JOIN digital_production_task_access original ON original.source_id=candidate."sourceId" AND original.task_kind='development_material_supply'
  JOIN digital_production_tasks task USING(task_id)
  WHERE original.assignee_id IS NOT NULL AND task.state='ready'
   AND NOT EXISTS(SELECT 1 FROM digital_production_resource_lifecycle state
    WHERE state.resource_kind='source' AND state.resource_id=candidate."sourceId" AND state.state<>'active')
   AND task.route_version=coalesce((SELECT max(round_number) FROM digital_development_rounds r WHERE r.source_id=candidate."sourceId"),1)`,
  [JSON.stringify(sources)])).rows;
 const observation=new Map(candidates.map(row=>[row.id,row.asOf]));
 await readJourneyCandidateCohort(db,rows,async(client,row)=>{
  if(!await new DigitalProductionAccessPolicy(client).activeRole(row.handlerId,row.role))return;
  const readiness=await materialReadiness(client,row.sourceId,row.round);
  const missing=readiness.supplyMissing.filter(material=>material.evidenceId);
  if(!missing.length)return;
  items.set(row.id,missing.map(material=>({orderId:row.id,category:'preparation_material',evidenceId:material.evidenceId!,
   handlerRole:row.role,handlerId:row.handlerId,missingObject:material.name,originalRoute:`/ui/digital-production?task=${row.taskId}&taskView=handle`,
   reason:'本轮原核料已标缺项，补料任务可办理',asOf:observation.get(row.id)!})));
 });
 return items;
}

/** Reuse the original technical partial-work decision and current warehouse
 * assignment. An ordinary missing receipt or a generic cutting blocker is
 * not an original request to supplement raw material. */
export async function readCockpitMaterialSupplements(db:PoolClient,candidates:readonly Candidate[]){
 const items=new Map<string,CockpitActionableTodo['items']>();
 if(!candidates.length)return items;
 const rows=(await db.query<{id:string;orderId:string;taskId:string}>(`SELECT r.id,r."orderId",t.task_id AS "taskId"
  FROM jsonb_to_recordset($1::jsonb) AS r(id uuid,"orderId" uuid)
  JOIN digital_production_orders o ON o.production_order_id=r."orderId"
  JOIN digital_bulk_preparations p ON p.production_order_id=o.production_order_id
  JOIN digital_instruction_documents d ON d.production_order_id=p.production_order_id AND d.published_version=p.instruction_version
  JOIN digital_production_tasks t ON t.route_instance_id=p.preparation_id
  JOIN digital_production_task_access a USING(task_id)
  WHERE a.task_kind='bulk_pattern' AND t.state NOT IN ('completed','cancelled')
   AND p.source_round=coalesce((SELECT max(round_number) FROM digital_development_rounds WHERE source_id=p.source_id),1)
   AND EXISTS(SELECT 1 FROM digital_bulk_work_ranges range WHERE range.task_id=t.task_id AND NOT range.complete)
   AND NOT EXISTS(SELECT 1 FROM digital_production_resource_lifecycle state
    WHERE ((state.resource_kind='order' AND state.resource_id=o.production_order_id) OR (state.resource_kind='source' AND state.resource_id=o.source_id)) AND state.state<>'active')
   AND NOT EXISTS(SELECT 1 FROM digital_order_closures closed WHERE closed.production_order_id=o.production_order_id)`,[JSON.stringify(candidates)])).rows;
 const observation=new Map(candidates.map(row=>[row.id,row.asOf]));
 await readJourneyCandidateCohort(db,rows,async(client,row)=>{
  const supplement=await preparationSupplement(client,row.taskId);
  if(!supplement||supplement.ready)return;
  const range=supplement.ranges.find(range=>Date.parse(range.occurred_at)<=Date.parse(observation.get(row.id)!));
  if(!range)return;
  const {warehouseWorkerId}=await preparationResponsibility(client,supplement.context);
  if(!warehouseWorkerId||!await new DigitalProductionAccessPolicy(client).activeRole(warehouseWorkerId,'warehouse_receiver'))return;
  const current=items.get(row.id)??[];
  if(!current.some(item=>item.evidenceId===range.range_id))current.push({
   orderId:row.id,category:'preparation_material',evidenceId:range.range_id,missingObject:'待补辅料',
   handlerRole:'warehouse_receiver',handlerId:warehouseWorkerId,
   originalRoute:`/ui/digital-production?bulk=${row.orderId}&materialKind=accessories_ready`,
   reason:'原纸样唛架局部已做，技术明确列出待补辅料',asOf:observation.get(row.id)!
  });
  items.set(row.id,current);
 });
 return items;
}

type InstructionBasis={
  id:string;motherId:string;primaryId:string;version:number;orderVersion:number;sourceId:string|null;sourceRound:number|null;latestRound:number|null;
  document:InstructionDocument;previouslyPublished:InstructionDocument|null;lines:Array<{lineId:string;sizes:Array<{size:string}>}>;
  imagesUsable:boolean;adoptedPreparation:boolean;existingPlan:boolean;
};

/** Read the original draft, current collaboration and document constraints as
 * one set. A legacy non-enrolled draft uses the original document-only gate.
 * A modern draft's additional native checks must have affirmative evidence. */
export async function readCockpitInstructionActions(database:Pool,db:PoolClient,actor:TrustedActorContext,orders:readonly Candidate[]){
 const items=new Map<string,CockpitActionableTodo['items']>(),unavailable=new Set<string>();
 if(!orders.length)return {items,unavailable};
 const typedTime=await acceptsNewOrderTime(db);
 const rows=(await db.query<InstructionBasis>(`SELECT requested.id,mother.production_order_id AS "motherId",
  primary_person.id AS "primaryId",draft.version,mother.version AS "orderVersion",mother.source_id AS "sourceId",draft.source_round AS "sourceRound",latest.round_number AS "latestRound",
  draft.document,published.document AS "previouslyPublished",coalesce(po.lines,'[]'::jsonb) AS lines,NOT EXISTS(
   SELECT 1 FROM jsonb_array_elements(draft.document->'images') AS picture(value)
   WHERE NOT EXISTS(SELECT 1 FROM attachments a WHERE a.attachment_id::text=picture.value->>'attachmentId'
    AND a.status='ready' AND a.mime_type IN ('image/jpeg','image/png','image/webp')
    AND (EXISTS(SELECT 1 FROM digital_instruction_attachment_bindings binding
       WHERE binding.production_order_id=mother.production_order_id AND binding.attachment_id=a.attachment_id)
      OR (a.entity_type='digital_development' AND a.entity_id=mother.source_id::text AND source.status='published'
       AND EXISTS(SELECT 1 FROM jsonb_array_elements(source.document->'files') AS file(value)
        WHERE file.value->>'attachmentId'=a.attachment_id::text AND file.value->>'kind' IN ('款图','局部图','工艺开发板')))
      OR (a.entity_type IS NULL AND a.uploaded_by=primary_person.id)))
  ) AS "imagesUsable",EXISTS(SELECT 1 FROM digital_preparation_rule_adoptions p
    WHERE p.resource_kind='order' AND p.resource_id=mother.production_order_id) AS "adoptedPreparation",
  EXISTS(SELECT 1 FROM digital_order_time_plan_versions p
    WHERE p.resource_kind='order' AND p.production_order_id=mother.production_order_id) AS "existingPlan"
  FROM jsonb_to_recordset($1::jsonb) AS requested(id uuid,"orderId" uuid)
  JOIN digital_production_orders mother ON mother.production_order_id=requested."orderId"
  JOIN digital_instruction_documents draft ON draft.production_order_id=mother.production_order_id
    AND draft.version>0 AND draft.version IS DISTINCT FROM draft.published_version
  LEFT JOIN digital_instruction_versions published ON published.production_order_id=mother.production_order_id AND published.version=draft.published_version
  JOIN app_users primary_person ON primary_person.id=mother.primary_merchandiser_id AND primary_person.enabled
   AND NOT coalesce((to_jsonb(primary_person)->>'manual_access_disabled')::boolean,false)
   AND EXISTS(SELECT 1 FROM user_role_assignments a JOIN business_roles r ON r.role_code=a.role_code AND r.enabled
    WHERE a.user_id=primary_person.id AND a.role_code='order_merchandiser' AND a.revoked_at IS NULL)
   AND EXISTS(SELECT 1 FROM identity_mappings m WHERE m.user_id=primary_person.id AND m.active AND m.employed)
  LEFT JOIN digital_development_documents source ON source.source_id=mother.source_id
  LEFT JOIN LATERAL (SELECT CASE WHEN source.source_id IS NOT NULL THEN coalesce(max(r.round_number),1) END AS round_number
    FROM digital_development_rounds r WHERE r.source_id=mother.source_id) latest ON true
  LEFT JOIN LATERAL (SELECT jsonb_agg(jsonb_build_object('lineId',line.line_id,'sizes',coalesce((
   SELECT jsonb_agg(jsonb_build_object('size',s.size)) FROM digital_production_po_sizes s WHERE s.line_id=line.line_id
  ),'[]'::jsonb))) AS lines FROM digital_production_po_lines line WHERE line.production_order_id=mother.production_order_id) po ON true
  WHERE NOT EXISTS(SELECT 1 FROM digital_production_resource_lifecycle state
   WHERE state.resource_kind='order' AND state.resource_id=mother.production_order_id AND state.state<>'active')
   AND NOT EXISTS(SELECT 1 FROM digital_production_child_links link JOIN cutting_orders c ON c.sourcing_case_id=link.child_id
    JOIN cutting_records r ON r.cutting_order_id=c.cutting_order_id
    WHERE link.production_order_id=mother.production_order_id AND link.module='sourcing')`,[JSON.stringify(orders)])).rows;
 const asOf=new Map(orders.map(row=>[row.id,row.asOf])),context=acceptanceBusinessContext();
 await readJourneyCandidateCohort(db,rows,async(client,row)=>{
  if(context&&!await context.acceptsActor(row.primaryId))return;
  if(row.sourceRound!==row.latestRound||!row.imagesUsable||instructionErrors(row.document,{lines:row.lines}).length)return;
  let expectedReadinessRevision:string|undefined;
  if(row.adoptedPreparation){
   const readiness=await productionReadiness(client,row.motherId);
   if(readiness.finalReasons.length)return;
   const table=readiness.context.sourceId&&row.sourceRound
    ?(await publishedTechnicalArtifact(client,readiness.context.sourceId,row.sourceRound))?.artifact.body.baseSizeTable:undefined;
   if(!table){unavailable.add(row.motherId);return;}
   if(!instructionMatchesTechnicalSizes(row.document,{lines:row.lines},table))return;
   expectedReadinessRevision=readiness.revision;
  }
  if(row.document.craftSteps?.some(step=>step.craftKind==='special')){
   const source=row.sourceId?(await developmentDocumentRow(client,row.sourceId,row.sourceRound??undefined)):null;
   try{await validateSpecialCraftChoices(client,row.document.craftSteps,[...(row.previouslyPublished?.craftSteps??[]),...(source?.document.craftSteps??[])],'bulk',undefined,false);}
   catch(error){if(error instanceof ApplicationError&&error.statusCode===409)return;throw error;}
  }
  if(typedTime||row.existingPlan){
   const scope={kind:'order' as const,id:row.motherId};
   const {time}=await new ContextBusinessClock(database,client).readObservation(scope,{now:()=>new Date(asOf.get(row.id)!),mode:'live'});
   if(time.now!==asOf.get(row.id)){unavailable.add(row.motherId);return;}
   const operation={kind:'instruction_publish' as const,orderId:row.motherId,input:{
    expectedVersion:row.version,orderVersion:row.orderVersion,...(expectedReadinessRevision?{expectedReadinessRevision}:{})}};
   try{
    const check=await loadOrderTimeOperation(database,client,actor,operation,time,{},[],[],'cockpit-instruction-read');
    if(check.check.feasibility==='unknown'){unavailable.add(row.motherId);return;}
    if(check.check.feasibility==='insufficient')return;
   }catch(error){
    if(!(error instanceof ApplicationError)||![403,409,422].includes(error.statusCode))throw error;
    unavailable.add(row.motherId);return;
   }
  }
  items.set(row.id,[{orderId:row.id,category:'instruction_publish',evidenceId:`instruction:${row.motherId}:v${row.version}`,
   missingObject:'当前大货制单版本尚未发布',handlerRole:'order_merchandiser',handlerId:row.primaryId,
   originalRoute:`/ui/digital-production?instruction=${row.motherId}`,reason:'当前制单草稿已具备原发布条件',asOf:asOf.get(row.id)!}]);
 });
 return {items,unavailable};
}
