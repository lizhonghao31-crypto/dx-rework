import {createHash,randomUUID} from 'node:crypto';
import {readBulkPreshrinkRequirement} from './bulk-preshrink-requirement.js';
import {z} from 'zod';
import type {Pool,PoolClient} from 'pg';
import {SeriesContextInputSchema,SeriesPreviewInputSchema,ApplySeriesPlanSchema,RequestSeriesPlanSchema,SeriesRequestDecisionSchema,SERIES_PLAN_RULE,
 type SeriesPlanPreview,type SeriesPlanState,type SeriesPlanSnapshot,type SeriesProfile,type SeriesPreviewInput,type SeriesRisk,type PlanningDependency} from '@dx-rework/contracts/digital-series-plan';
import {beijingCalendarDate} from '@dx-rework/contracts/digital-production';
import {seriesMilestones,retainSeriesTargets,evaluatePlanningDependencies} from '@dx-rework/domain/series-plan';
import {isRootActor} from '../access/business-authority.js';
import {ApplicationError} from '../platform/errors.js';
import type {TrustedActorContext} from '../tools/repositories.js';
import {ContextBusinessClock} from '../acceptance-clock/business-time.js';
import {DigitalProductionAccessPolicy,digitalForbidden,digitalNotFound} from './access-policy.js';
import {assertSlaSettingsActor,assertSlaSettingsReadActor} from './sla-settings-authority.js';
import {SlaPreviewTokens} from './sla-preview-token.js';
import {readSeriesPlanFacts} from './series-plan-facts.js';
type DB=Pick<Pool|PoolClient,'query'>;
const fail=(text:string):never=>{throw new ApplicationError('SERIES_PLAN_CONFLICT',text,409);};
const canonical=(v:unknown):unknown=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,value])=>[k,canonical(value)])):v;
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
function parse<T>(schema:{safeParse(v:unknown):{success:true;data:T}|{success:false;error:{issues:Array<{message:string}>}}},v:unknown):T{const p=schema.safeParse(v);if(!p.success)throw new ApplicationError('VALIDATION_ERROR',p.error.issues[0]?.message??'请核对计划资料',400);return p.data;}
export class SeriesPlanService{
 private readonly tokens:SlaPreviewTokens;
 constructor(private readonly database:Pool,secret?:string){this.tokens=new SlaPreviewTokens(secret);}
 async creationPreview(actor:TrustedActorContext,raw:unknown){
  parse(z.object({customerCode:z.string().max(100),salesYear:z.number().int().min(1000).max(9999),salesSeries:z.enum(['P01','P02','P03','P04','P05','P06','P07','P08','P09','P10','P11','P12']),requiresColorMatching:z.boolean().nullable()}).strict(),raw);
  if(!isRootActor(actor)&&(!actor.actorRoles.includes('sample_designer')||!(actor.authorizationCapabilities??[]).includes('pattern_room:orders:create')||!await new DigitalProductionAccessPolicy(this.database).activeRole(actor.actorId,'sample_designer')))digitalForbidden();
  return {profile:await this.profile(this.database,null),candidateDate:null,basis:'unavailable',milestones:[],suggestionsEnabled:false};
 }
 private async order(db:DB,actor:TrustedActorContext,id:string,readOnly=false){const p=new DigitalProductionAccessPolicy(db);await p.assert(actor,'order',id,'technical');const row=(await db.query('SELECT * FROM digital_production_orders WHERE production_order_id=$1',[id])).rows[0]??digitalNotFound();
  if(isRootActor(actor))return row;
  if(readOnly&&actor.actorRoles.includes('pmc')&&await p.activeRole(actor.actorId,'pmc'))return row;
  for(const role of ['production_management','owner_group','pattern_room_supervisor','development_clerk'])if(actor.actorRoles.includes(role)&&await p.activeRole(actor.actorId,role))return row;
  if(row.created_by===actor.actorId&&actor.actorRoles.includes('sample_designer')&&await p.activeRole(actor.actorId,'sample_designer'))return row;
  if(row.primary_merchandiser_id===actor.actorId&&actor.actorRoles.includes('order_merchandiser')&&await p.activeRole(actor.actorId,'order_merchandiser'))return row;
  return digitalNotFound();}
 private async active(db:DB,id:string){return !(await db.query("SELECT 1 FROM digital_production_resource_lifecycle WHERE resource_kind='order' AND resource_id=$1 AND state<>'active' UNION ALL SELECT 1 FROM digital_order_closures WHERE production_order_id=$1",[id])).rowCount;}
 private async manager(db:DB,actor:TrustedActorContext,write=false){try{await assertSlaSettingsActor(db,actor,write);return true;}catch(e){if(e instanceof ApplicationError&&e.statusCode===403)return false;throw e;}}
 private async designer(db:DB,actor:TrustedActorContext,order:Record<string,unknown>,write=false){if(isRootActor(actor))return true;
  const p=new DigitalProductionAccessPolicy(db);return order.created_by===actor.actorId&&actor.actorRoles.includes('sample_designer')&&await(write?p.lockActiveRole(actor.actorId,'sample_designer'):p.activeRole(actor.actorId,'sample_designer'));}
 private async requester(db:DB,actor:TrustedActorContext,order:Record<string,unknown>,write=false){if(await this.designer(db,actor,order,write)||await this.manager(db,actor,write))return true;
  const p=new DigitalProductionAccessPolicy(db);return order.primary_merchandiser_id===actor.actorId&&actor.actorRoles.includes('order_merchandiser')&&await(write?p.lockActiveRole(actor.actorId,'order_merchandiser'):p.activeRole(actor.actorId,'order_merchandiser'));}
 async profile(db:DB,customerCode:string|null):Promise<SeriesProfile>{
  void db;void customerCode;
  // Legacy response shape only. Historical adopted snapshots retain their own
  // profile; no profile or fallback date is used for a new plan.
  return {customerCode:null,version:0,monthOffset:0,shippingDay:null,suggestionDay:15,configured:false};
 }
 private async history(db:DB,id:string):Promise<SeriesPlanSnapshot[]>{return (await db.query('SELECT snapshot_json FROM digital_series_plans WHERE production_order_id=$1 ORDER BY revision DESC',[id])).rows.map(r=>r.snapshot_json);}
 private async prepare(db:PoolClient,actor:TrustedActorContext,id:string,input:SeriesPreviewInput):Promise<SeriesPlanPreview>{
  const order=await this.order(db,actor,id),history=await this.history(db,id),previous=history[0]??null;
  if(order.version!==input.expectedOrderVersion||(previous?.revision??0)!==input.expectedPlanRevision)fail('订单或计划版本已更新，请重新预览');
  const profile=await this.profile(db,order.customer_code),native=await readSeriesPlanFacts(db,id,order.source_id,order.customer_code),time=await new ContextBusinessClock(this.database,db).read({kind:'order',id});
  const route=order.requires_color_matching===true?'A':order.requires_color_matching===false?'B':null;
  const candidateDate=input.plannedShippingDate,basis:SeriesPlanPreview['basis']=candidateDate?'manual':'unavailable';const risks:SeriesRisk[]=[];
  if(!route)risks.push({code:'DESIGN_ROUTE_MISSING',tone:'unknown',nodeId:null,message:'设计尚未明确辅料是否需对色，无法生成A/B路线'});
  if(!candidateDate)risks.push({code:'PLAN_DATE_MISSING',tone:'unknown',nodeId:null,message:'请在原交期入口确认真实日期，或明确填写有效的计划日期'});
  const lines=(await db.query(`SELECT line_id,po_number,color,coalesce(customer_warehouse_arrival_date,delivery_date)::text AS date,factory_delivery_date::text AS factory_date,customer_date_version AS version FROM digital_production_po_lines WHERE production_order_id=$1 ORDER BY position`,[id])).rows;
  for(const line of lines)if(candidateDate&&line.date&&line.date<candidateDate)risks.push({code:'CUSTOMER_EARLIER_THAN_PLAN',tone:'danger',nodeId:null,message:`${line.po_number??line.color} 客户约定出货 ${line.date} 早于计划 ${candidateDate}；请有权调整计划或办理客户改期，系统不覆盖任一日期`});
  const shipmentLocked=native.facts.some(f=>f.key==='planned_shipment'&&f.scopeRef==='whole'&&(f.completed||f.started));
  if(candidateDate&&shipmentLocked&&candidateDate!==previous?.plannedShippingDate)fail('本单已形成实际出货事实，计划出货锚点保留原版；不能补造或平移历史计划');
  if(input.selectedNodeIds&&!input.selectedNodeIds.includes('planned_shipment:whole')&&!shipmentLocked)fail('计划出货日期是倒排锚点，必须与本次计划同步采用');
  let milestones:SeriesPlanPreview['milestones']=[],selectedNodeIds:string[]=[];
  if(candidateDate&&route){try{({milestones,selectedNodeIds}=retainSeriesTargets(seriesMilestones(candidateDate,route),previous?.milestones??[],native.facts,input.selectedNodeIds,previous?.revision??0));}catch(e){fail((e as Error).message);}}
  const date=(key:string)=>milestones.find(m=>m.key===key)?.targetDate??null;
  for(const m of milestones)if(m.targetDate&&m.targetDate<beijingCalendarDate(new Date(time.now))&&!native.facts.some(f=>f.key===m.key&&f.scopeRef===m.scopeRef&&f.completed))risks.push({code:'PLANNED_NODE_PAST_DUE',tone:'warning',nodeId:m.id,message:`${m.label}计划截止 ${m.targetDate} 已过；原逾期事实不会因改期消除`});
  const slaRecord=(await db.query('SELECT snapshot_id,revision,parameters_json FROM digital_sla_order_snapshots WHERE production_order_id=$1 ORDER BY revision DESC LIMIT 1',[id])).rows[0],frozen=slaRecord?.parameters_json;
  const instructionRecord=(await db.query(`SELECT d.document,d.version,d.source_round,p.preparation_id,p.preshrink FROM digital_instruction_documents h
   JOIN digital_instruction_versions d ON d.production_order_id=h.production_order_id AND d.version=h.published_version
   LEFT JOIN digital_bulk_preparations p ON p.production_order_id=d.production_order_id AND p.instruction_version=d.version AND p.source_round=d.source_round
   WHERE h.production_order_id=$1`,[id])).rows[0],instruction=instructionRecord?.document;
  const craft=instruction?.secondaryCraft&&instruction.secondaryCraft!=='沿用开发'?instruction.secondaryCraft:native.document?.document?.craft;
  const estimates:Record<string,number|null>={fabric_inspection:1440,fabric_preshrink:2160,size_review:1440,instruction:1440,pattern_marker:2880,cutting:1440,post_cut_craft:craft==='无'?0:['印花','绣花'].includes(craft)?5760:craft==='印绣花'?10080:null,post_cut_check:craft==='无'?0:2880,dispatch:1440,factory_production:null,return_logistics:2880,garment_qc:2880,packing:1440};
  const slaKeys:Record<string,string>={fabric_inspection:'fabric_inspection',fabric_preshrink:'warehouse_preshrink',pattern_marker:'bulk_pattern',cutting:'bulk_cutting',post_cut_craft:craft==='印花'?'bulk_printing':craft==='绣花'?'bulk_embroidery':'bulk_print_embroidery',post_cut_check:'bulk_qc',dispatch:'warehouse_dispatch',return_logistics:'return_logistics',garment_qc:'garment_qc',packing:'packing'};
  for(const [key,sla] of Object.entries(slaKeys)){const value=frozen?.[sla]?.value;if(value&&'minutes' in value&&!(key==='post_cut_craft'&&craft==='无')&&!(key==='post_cut_check'&&craft==='无'))estimates[key]=value.minutes;}
  const graph:PlanningDependency[]=[];
  const anchor=(id:string,label:string,key:string,deps:string[]=[],days=0)=>graph.push({id,label,scopeRef:'whole',dependsOn:deps,anchorDate:date(key),durationMinutes:days*1440,basis:'confirmed',targetDate:date(key)});
  anchor('handover','设计资料交接计划','design_handover');anchor('investment','跟单投料计划','material_investment',['handover']);
  // These lead times are the approved natural-day template, not invented capacity durations.
  graph.push({id:'fabric',label:'面料到仓周期',scopeRef:'whole',dependsOn:['investment'],anchorDate:null,durationMinutes:(route==='A'?41:31)*1440,basis:route?'confirmed':'unknown',targetDate:date('fabric_receipt')});
  anchor('approval','客户最终批复计划','client_sample_approval');
  if(route==='A')graph.push({id:'color',label:'对色周期',scopeRef:'whole',dependsOn:['fabric'],anchorDate:null,durationMinutes:12*1440,basis:'confirmed',targetDate:date('color_confirmation')});
  anchor('accessories','辅料实物备齐计划','accessories_ready',route==='A'?['color']:[]);anchor('label','款号唛实物备齐计划','style_label_ready');
  const task=(key:keyof SeriesPreviewInput['plannedDurations'],label:string,deps:string[],target:string|null=null,scope='whole')=>{const id=scope==='whole'?key:`${key}:${scope}`;graph.push({id,label,scopeRef:scope,dependsOn:deps,anchorDate:null,durationMinutes:input.plannedDurations[key]??estimates[key]??null,basis:input.plannedDurations[key]!==undefined?'confirmed':'estimate',targetDate:target});return id;};
  task('fabric_inspection','验布质量核验',['fabric']);task('size_review','最终批复后尺寸复核',['approval']);
  graph.push({id:'instruction_draft',label:'到仓后制单草稿协同目标',scopeRef:'whole',dependsOn:['fabric'],anchorDate:null,durationMinutes:1440,basis:'confirmed'});
  task('instruction','前提齐备后跟单正式制单',['fabric_inspection','size_review']);task('pattern_marker','纸样及唛架',['instruction']);
  // Missing auxiliaries do not stop unaffected paper work. Physical labels and auxiliaries precede cutting.
  const effectivePreshrink=await readBulkPreshrinkRequirement(db,instructionRecord?.preparation_id?instructionRecord:null,instruction),preshrink=effectivePreshrink.requirement,needsPreshrink=preshrink==='需要预缩';
  if(needsPreshrink)task('fabric_preshrink','适用面料预缩',['fabric_inspection']);
  for(const line of lines){const scope=`po:${line.line_id}`,label=line.po_number??line.color;
   const cut=task('cutting',`${label} 开裁及实裁`,['pattern_marker','accessories','label',needsPreshrink?'fabric_preshrink':'fabric_inspection'],null,scope);
   const craftTask=task('post_cut_craft',`${label} 适用裁后工艺`,[cut],null,scope),qc=task('post_cut_check',`${label} 裁后总查`,[craftTask],null,scope);
   const dispatch=task('dispatch',`${label} 仓库发加工`,[qc],date('processing_dispatch'),scope);
   const production=task('factory_production',`${label} 工厂生产（未填工期则不推定产能）`,[dispatch],line.factory_date??null,scope);
   const returned=task('return_logistics',`${label} 回仓运输估算`,[production],null,scope),check=task('garment_qc',`${label} 回货成衣QC`,[returned],null,scope);
   task('packing',`${label} 可装齐后的装箱作业`,[check],candidateDate,scope);
  }
  const dependencies=evaluatePlanningDependencies(graph);
  if(preshrink!=='需要预缩'&&preshrink!=='无需预缩')risks.push({code:'PRESHRINK_ROUTE_UNKNOWN',tone:'unknown',nodeId:null,message:'预缩适用性尚未明确；当前关键路径未加入未知路线，不能据此认定可按期'});
  if(!['无','印花','绣花','印绣花'].includes(craft))risks.push({code:'CRAFT_ROUTE_UNKNOWN',tone:'unknown',nodeId:null,message:'有效大货工艺路线尚未明确，关键路径结果不完整'});
  for(const n of dependencies)if(n.lateMinutes)risks.push({code:'DEPENDENCY_LATE',tone:'danger',nodeId:n.id,message:`${n.label}按当前前提及计划工期预计晚于目标 ${Math.ceil(n.lateMinutes/1440)} 天；不自动压缩或平移客户日期`});
  if(input.plannedDurations.factory_production===undefined)risks.push({code:'FACTORY_CAPACITY_UNKNOWN',tone:'unknown',nodeId:null,message:'工厂生产计划工期尚未确认；按PO/批次并行展示前后依赖，不把未知产能当零天或承诺准期'});
  risks.push({code:'PLAN_ESTIMATE_SCOPE',tone:'warning',nodeId:null,message:'依赖图按当前适用路线估算，不代表产能承诺。各批需按真实可用及实裁范围办理；实际SLA仍按原起止事件独立计时'});
  const sourceRevisionSet={rule:SERIES_PLAN_RULE,orderVersion:order.version,series:[order.sales_year,order.sales_series,order.requires_color_matching],profile,lines,nativeRef:{sourceId:order.source_id,documentVersion:native.document?.version??null,round:native.document?.round_number??null,technicalRevision:(native.revisions.technical as {revision?:string}|undefined)?.revision??null},factRefs:native.facts.map(f=>({key:f.key,scope:f.scopeRef,domain:f.sourceDomain,id:f.sourceRecordId,version:f.sourceVersion})),slaSnapshotRef:slaRecord?{id:slaRecord.snapshot_id,revision:slaRecord.revision}:null,instructionRef:instructionRecord?{version:instructionRecord.version,sourceRound:instructionRecord.source_round,preparationId:instructionRecord.preparation_id??null,preshrink,correctionId:effectivePreshrink.correctionId}:null,nativeFingerprint:hash(native.revisions),parameterFingerprint:hash(frozen??null),instructionFingerprint:hash(instruction??null),clock:{day:beijingCalendarDate(new Date(time.now)),scenarioId:time.scenarioId,revision:time.revision},planRevision:previous?.revision??0,input};
  return {orderId:id,input,orderVersion:order.version,planRevision:previous?.revision??0,profile,candidateDate,basis,route,previewToken:this.tokens.issue(hash(sourceRevisionSet)),milestones,facts:native.facts,selectedNodeIds,risks,planningGraph:graph,dependencies,sourceRevisionSet};
 }
 async preview(actor:TrustedActorContext,id:string,raw:unknown){const input=parse(SeriesPreviewInputSchema,raw),db=await this.database.connect();try{await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ');const p=await this.prepare(db,actor,id,input);await db.query('COMMIT');return p;}catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}}
 async read(actor:TrustedActorContext,id:string):Promise<SeriesPlanState>{const db=await this.database.connect();try{await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  const order=await this.order(db,actor,id,true),history=await this.history(db,id),time=await new ContextBusinessClock(this.database,db).read({kind:'order',id}),active=await this.active(db,id);
  const facts=(await readSeriesPlanFacts(db,id,order.source_id,order.customer_code)).facts,profile=await this.profile(db,order.customer_code),current=history[0]??null;
  const customerDates=(await db.query(`SELECT line_id AS "lineId",po_number AS "poNumber",color,coalesce(customer_warehouse_arrival_date,delivery_date)::text AS date,factory_delivery_date::text AS factory_date,customer_date_version AS version FROM digital_production_po_lines WHERE production_order_id=$1 ORDER BY position`,[id])).rows;
  const pending=(await db.query(`SELECT r.*,r.candidate_date::text AS candidate_date FROM digital_series_requests r LEFT JOIN digital_series_request_decisions d USING(request_id) WHERE r.production_order_id=$1 AND d.request_id IS NULL ORDER BY r.recorded_at DESC`,[id])).rows;
  const currentRisks:SeriesRisk[]=[];
  if(current){for(const line of customerDates)if(line.date&&line.date<current.plannedShippingDate)currentRisks.push({code:'CUSTOMER_EARLIER_THAN_PLAN',tone:'danger',nodeId:null,message:`${line.poNumber??line.color} 客户约定出货 ${line.date} 早于当前计划 ${current.plannedShippingDate}；冲突仍在，未因采用或刷新消除`});
   if(current.salesYear!==order.sales_year||current.salesSeries!==order.sales_series||current.route!==(order.requires_color_matching===true?'A':order.requires_color_matching===false?'B':null))currentRisks.push({code:'SERIES_CONTEXT_CHANGED',tone:'warning',nodeId:null,message:'销售系列或设计对色分类已变，当前采用计划仍保留原版；请有权人员重新预览决定'});}
  const result:SeriesPlanState={orderId:id,serverToday:beijingCalendarDate(new Date(time.now)),orderVersion:order.version,sourceId:order.source_id,canEditSeries:active&&await this.designer(db,actor,order),canApply:active&&await this.manager(db,actor),canRequest:active&&await this.requester(db,actor,order),active,
   salesYear:order.sales_year,salesSeries:order.sales_series,requiresColorMatching:order.requires_color_matching,profile,customerDates,current,history,facts,risks:currentRisks,pendingRequests:pending.map(r=>({requestId:r.request_id,requestedBy:r.requested_by,reason:r.reason,candidateDate:r.candidate_date?String(r.candidate_date).slice(0,10):null,requestedAt:new Date(r.recorded_at).toISOString(),input:r.input_json,stale:r.order_version!==order.version||r.expected_plan_revision!==(current?.revision??0)}))};
  await db.query('COMMIT');return result;
 }catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}}
 private async audit(db:PoolClient,actor:TrustedActorContext,id:string,action:string,after:unknown){const eventId=randomUUID();await db.query("INSERT INTO audit_events(id,request_id,actor_id,action,entity_type,entity_id,after_state) VALUES($1,$2,$3,$4,'digital_production',$5,$6)",[eventId,actor.requestId,actor.actorId,action,id,JSON.stringify(after)]);return eventId;}
 private async command<T>(actor:TrustedActorContext,id:string,kind:string,key:string,input:unknown,authorize:(db:PoolClient,order:Record<string,unknown>)=>Promise<boolean>,work:(db:PoolClient,order:Record<string,unknown>)=>Promise<T>):Promise<T>{
  if(!/^[A-Za-z0-9._:-]{1,128}$/.test(key))throw new ApplicationError('VALIDATION_ERROR','缺少有效操作标识',400);
  const db=await this.database.connect();try{await db.query('BEGIN');await db.query("SELECT pg_advisory_xact_lock(hashtextextended('digital-production-task-lifecycle-v1',0))");const order=await this.order(db,actor,id);await db.query('SELECT production_order_id FROM digital_production_orders WHERE production_order_id=$1 FOR UPDATE',[id]);
   if(!await authorize(db,order))digitalForbidden();const time=await new ContextBusinessClock(this.database,db).read({kind:'order',id}),command=`series:${id}:${time.scenarioId??'real'}:${kind}`,fingerprint=hash(input);
   const prior=(await db.query('SELECT payload_hash,response FROM digital_production_commands WHERE actor_id=$1 AND command=$2 AND key=$3',[actor.actorId,command,key])).rows[0];if(prior&&prior.payload_hash!==fingerprint)fail('操作标识已用于不同内容');
   if(!await this.active(db,id))fail('母单已暂停、取消或结案');const result=prior?prior.response as T:await work(db,order);
   if(!prior)await db.query('INSERT INTO digital_production_commands(actor_id,command,key,payload_hash,response) VALUES($1,$2,$3,$4,$5)',[actor.actorId,command,key,fingerprint,JSON.stringify(result)]);
   await db.query('COMMIT');return result;
  }catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
 }
 async context(actor:TrustedActorContext,id:string,raw:unknown,key:string){const input=parse(SeriesContextInputSchema,raw);if((input.salesYear===null)!==(input.salesSeries===null))throw new ApplicationError('VALIDATION_ERROR','销售年份与系列须一起选择或清空',400);
  return this.command(actor,id,'context',key,input,(db,o)=>this.designer(db,actor,o,true),async(db,o)=>{if(o.version!==input.expectedOrderVersion)fail('订单资料已更新，请刷新');
   const before={salesYear:o.sales_year,salesSeries:o.sales_series,requiresColorMatching:o.requires_color_matching},after={salesYear:input.salesYear,salesSeries:input.salesSeries,requiresColorMatching:input.requiresColorMatching};
   const time=await new ContextBusinessClock(this.database,db).read({kind:'order',id}),audit=await this.audit(db,actor,id,'series_context_changed',{before,after,reason:input.reason});
   await db.query('UPDATE digital_production_orders SET sales_year=$2,sales_series=$3,requires_color_matching=$4,version=version+1 WHERE production_order_id=$1',[id,input.salesYear,input.salesSeries,input.requiresColorMatching]);
   await db.query('INSERT INTO digital_series_context_changes(change_id,production_order_id,order_version,before_json,after_json,reason,created_by,business_time,audit_event_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[randomUUID(),id,Number(o.version)+1,JSON.stringify(before),JSON.stringify(after),input.reason,actor.actorId,JSON.stringify(time),audit]);return {orderVersion:Number(o.version)+1};});
 }
 async request(actor:TrustedActorContext,id:string,raw:unknown,key:string){const input=parse(RequestSeriesPlanSchema,raw);return this.command(actor,id,'request',key,input,(db,o)=>this.requester(db,actor,o,true),async db=>{const p=await this.prepare(db,actor,id,SeriesPreviewInputSchema.parse(Object.fromEntries(Object.entries(input).filter(([k])=>k!=='reason'))));if(!p.candidateDate||!p.route)fail('计划日期或设计对色路线不完整');
  const requestId=randomUUID(),time=await new ContextBusinessClock(this.database,db).read({kind:'order',id}),audit=await this.audit(db,actor,id,'series_plan_requested',{requestId,input,candidateDate:p.candidateDate});
  await db.query('INSERT INTO digital_series_requests(request_id,production_order_id,expected_plan_revision,order_version,input_json,candidate_date,reason,requested_by,business_time,audit_event_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[requestId,id,input.expectedPlanRevision,input.expectedOrderVersion,JSON.stringify(p.input),p.candidateDate,input.reason,actor.actorId,JSON.stringify(time),audit]);return {requestId};});}
 async apply(actor:TrustedActorContext,id:string,raw:unknown,key:string){const input=parse(ApplySeriesPlanSchema,raw);return this.command(actor,id,'apply',key,input,db=>this.manager(db,actor,true),async db=>{
  const previewInput=SeriesPreviewInputSchema.parse(Object.fromEntries(Object.entries(input).filter(([k])=>!['previewToken','reason','acceptSuggestedDate','requestId'].includes(k)))),p=await this.prepare(db,actor,id,previewInput);
  this.tokens.verify(input.previewToken,hash(p.sourceRevisionSet));if(!p.candidateDate||!p.route)fail('计划日期或设计对色路线不完整');if(input.acceptSuggestedDate&&!input.plannedShippingDate)fail('系列默认建议已取消，请明确填写有效的计划日期');
  if(input.requestId){const r=(await db.query('SELECT * FROM digital_series_requests WHERE request_id=$1 AND production_order_id=$2',[input.requestId,id])).rows[0];if(!r)digitalNotFound();if(!isRootActor(actor)&&r.requested_by===actor.actorId)digitalForbidden();if(hash(r.input_json)!==hash(p.input))fail('申请条件已变，请按原申请重新预览或驳回后重新申请');if((await db.query('SELECT 1 FROM digital_series_request_decisions WHERE request_id=$1',[input.requestId])).rowCount)fail('申请已处理');}
  const planId=randomUUID(),time=await new ContextBusinessClock(this.database,db).read({kind:'order',id}),snapshot:SeriesPlanSnapshot={revision:p.planRevision+1,plannedShippingDate:p.candidateDate!,route:p.route!,salesYear:p.sourceRevisionSet.series instanceof Array?p.sourceRevisionSet.series[0]:null,salesSeries:p.sourceRevisionSet.series instanceof Array?p.sourceRevisionSet.series[1]:null,profile:p.profile,milestones:p.milestones,plannedDurations:p.input.plannedDurations,planningGraph:p.planningGraph,dependencies:p.dependencies,risks:p.risks,slaSnapshotRef:p.sourceRevisionSet.slaSnapshotRef as {id:string;revision:number}|null,reason:input.reason,createdBy:actor.actorId,recordedAt:new Date((await db.query('SELECT CURRENT_TIMESTAMP AS at')).rows[0].at).toISOString()};
  const audit=await this.audit(db,actor,id,'series_plan_applied',{planId,snapshot,sourceRevisionSet:p.sourceRevisionSet,risks:p.risks});
  await db.query('INSERT INTO digital_series_plans(plan_id,production_order_id,revision,planned_shipping_date,route,snapshot_json,source_revisions,created_by,business_time,audit_event_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[planId,id,snapshot.revision,p.candidateDate,p.route,JSON.stringify(snapshot),JSON.stringify(p.sourceRevisionSet),actor.actorId,JSON.stringify(time),audit]);
  if(input.requestId)await db.query('INSERT INTO digital_series_request_decisions(request_id,approved,plan_id,reason,decided_by,audit_event_id,business_time) VALUES($1,true,$2,$3,$4,$5,$6)',[input.requestId,planId,input.reason,actor.actorId,audit,JSON.stringify(time)]);return snapshot;
 });}
 async reject(actor:TrustedActorContext,id:string,requestId:string,raw:unknown,key:string){const input=parse(SeriesRequestDecisionSchema,raw);return this.command(actor,id,`reject:${requestId}`,key,input,db=>this.manager(db,actor,true),async db=>{const r=(await db.query('SELECT * FROM digital_series_requests WHERE production_order_id=$1 AND request_id=$2',[id,requestId])).rows[0]??digitalNotFound();if(!isRootActor(actor)&&r.requested_by===actor.actorId)digitalForbidden();if((await db.query('SELECT 1 FROM digital_series_request_decisions WHERE request_id=$1',[requestId])).rowCount)fail('申请已处理');const time=await new ContextBusinessClock(this.database,db).read({kind:'order',id}),audit=await this.audit(db,actor,id,'series_plan_rejected',{requestId,...input});await db.query('INSERT INTO digital_series_request_decisions(request_id,approved,reason,decided_by,audit_event_id,business_time) VALUES($1,false,$2,$3,$4,$5)',[requestId,input.reason,actor.actorId,audit,JSON.stringify(time)]);return {requestId,approved:false};});}
 async profiles(actor:TrustedActorContext){await assertSlaSettingsReadActor(this.database,actor);return {profiles:[]};}
 async saveProfile(actor:TrustedActorContext,raw:unknown,key:string){
  void raw;void key;
  await assertSlaSettingsActor(this.database,actor,true);
  fail('销售系列默认建议已取消，请在原订单交期入口确认日期');
 }
}
