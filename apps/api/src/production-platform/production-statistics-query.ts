import {createHash} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {beijingCalendarDate} from '@dx-rework/contracts/digital-production';
import type {DigitalAnalysisFilters} from '@dx-rework/contracts/digital-production-analysis';
import type {ProductionStatisticsFilters,ProductionStatisticsResponse,StatisticsMetric,StatisticsPo,StatisticsProblem,StatisticsTime,StatisticsWindow,StatisticsWorkload} from '@dx-rework/contracts/production-statistics';
import {currentProductionStatistics} from '@dx-rework/domain/production-statistics';
import type {TrustedActorContext} from '../tools/repositories.js';
import {isRootActor} from '../access/business-authority.js';
import {assertBusinessExportAllowed} from '../access/export-authority.js';
import {ApplicationError} from '../platform/errors.js';
import {acceptanceBusinessContext,acceptanceIncludesNative,assertBusinessClockUnchanged,ContextBusinessClock,observedBusinessTime} from '../acceptance-clock/business-time.js';
import {DigitalProductionAccessPolicy,digitalForbidden} from './access-policy.js';
import {assertIdentityActor} from './identity-service.js';
import {AnalysisResultStore} from './analysis-result-store.js';
import {OrderClosureService} from './order-closure-service.js';
import {factoryProductionScopes} from './factory-production-facts.js';
import {BulkPreparationService} from './bulk-preparation-service.js';
import {RECEIVING_ANALYSIS_LINKS_SQL} from '../receiving/receiving-analysis.js';
import {retiredBulkPreshrinkTaskIds} from './bulk-preshrink-requirement.js';
import {taskAnalysis,type AnalysisTask} from './reporting-metrics.js';
import {ReworkBusinessDetailService} from '../rework/rework-business-detail-service.js';
import {productionMaterialFacts} from './production-statistics-materials.js';
import {productionGroups} from './production-statistics-groups.js';
import {productionFacets} from './production-statistics-dimensions.js';
import {productionResultProjection,scopedMotherCompletion} from './production-statistics-projection.js';

const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const none=():StatisticsTime=>({at:null,date:null,precision:'unknown',quality:'unknown',sourceRefs:[]});
const at=(value:Date|string|null|undefined,ref:string,trusted=true):StatisticsTime=>value?{at:new Date(value).toISOString(),date:null,precision:'instant',quality:trusted?'verified':'unverified',sourceRefs:[ref]}:none();
const sorted=(ids:readonly string[])=>[...new Set(ids)].sort();
const currentFilters=(filters:DigitalAnalysisFilters):ProductionStatisticsFilters=>({from:filters.from,to:filters.to,customer:filters.customer,category:filters.category,page:filters.page,view:'production',...Object.fromEntries(['factoryId','lineId','salesYear','salesSeries','primaryMerchandiserId','secondaryMerchandiserId','designer','drillLineId','drillOrderId','drillFactoryId','drillMetric','drillFactories','drillCustomers','drillStages','groupBy'].filter(key=>filters[key as keyof DigitalAnalysisFilters]!==undefined).map(key=>[key,filters[key as keyof DigitalAnalysisFilters]]))});
const filterHash=(filters:ProductionStatisticsFilters)=>hash(Object.fromEntries(Object.entries(filters).filter(([key])=>!['page','snapshotId','drillLineId','drillOrderId','drillFactoryId','drillMetric','drillFactories','drillCustomers','drillStages','groupBy'].includes(key))));
type StatisticsOrder={production_order_id:string;source_id:string|null;version:number|string;customer_code:string;design_style_no:string;product_group:string;sales_year:number|null;sales_series:string|null;primary_merchandiser_id:string|null;verified_designer:string|null};
/** An adapter of the original analysis surface, never a second business ledger. */
export class ProductionStatisticsQuery{
 private readonly store:AnalysisResultStore;
 constructor(private readonly database:Pool){this.store=new AnalysisResultStore(database);}
 private async liveActor(db:PoolClient,actor:TrustedActorContext){
  assertIdentityActor(actor);const policy=new DigitalProductionAccessPolicy(db),roles:string[]=[];
  for(const role of actor.actorRoles)if(role==='root_superuser'?isRootActor(actor)&&(await db.query('SELECT access_is_root_actor($1) AS allowed',[actor.actorId])).rows[0]?.allowed:await policy.activeRole(actor.actorId,role))roles.push(role);
  const currentCapabilities=new Set<string>((await db.query('SELECT DISTINCT capability FROM role_capabilities WHERE role_code=ANY($1::text[])',[roles])).rows.map(row=>row.capability));
  const live={...actor,actorRoles:roles,authorizationCapabilities:isRootActor({...actor,actorRoles:roles})?(actor.authorizationCapabilities??[]):(actor.authorizationCapabilities??[]).filter(capability=>currentCapabilities.has(capability))};assertIdentityActor(live);
  // authorizationCapability names the requested operation; it does not grant it.
  if(!isRootActor(live)&&!live.authorizationCapabilities?.includes('report:view'))digitalForbidden();
  return live;
 }
 private exportAllowed(actor:TrustedActorContext){try{assertBusinessExportAllowed(actor.actorRoles,'report:export');return isRootActor(actor)||(actor.authorizationCapabilities??[]).includes('report:view');}catch{return false;}}
 private async permission(db:PoolClient,actor:TrustedActorContext,orderIds:string[],taskIds:string[],reworkIds:string[]=[]){
  const policy=new DigitalProductionAccessPolicy(db);for(const id of sorted(orderIds))if(!await acceptanceIncludesNative(this.database,id)||!await policy.allowed(actor,'order',id,'technical'))digitalForbidden();
  for(const id of sorted(taskIds))if(!await policy.allowed(actor,'task',id,'technical'))digitalForbidden();
  const detail=new ReworkBusinessDetailService(this.database);for(const id of sorted(reworkIds)){const row=(await db.query("SELECT * FROM rework_orders WHERE rework_order_id=$1",[id])).rows[0];if(!row||!await detail.canViewExisting(actor,row,db)||!await detail.canViewExistingBusinessDetails(actor,row,db))digitalForbidden();}
  return hash({actorId:actor.actorId,roles:sorted(actor.actorRoles),capabilities:sorted([...(actor.authorizationCapabilities??[]),actor.authorizationCapability??'']),orders:sorted(orderIds),tasks:sorted(taskIds),reworks:sorted(reworkIds),scene:acceptanceBusinessContext()?.scenarioId??null,canExport:this.exportAllowed(actor)});
 }
 private async read<T>(work:(db:PoolClient)=>Promise<T>){
  const db=await this.database.connect();try{await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');const result=await work(db);await db.query('COMMIT');return result;}catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
 }
 async list(actor:TrustedActorContext,filters:DigitalAnalysisFilters,exportAll=false):Promise<ProductionStatisticsResponse>{
  const applied=currentFilters(filters),key=filterHash(applied);
  if(filters.page>1&&!filters.snapshotId)throw new ApplicationError('ANALYSIS_RESULT_REQUIRED','请先整体读取结果，再按同版结果翻页',409);
  if(filters.snapshotId){
   const stored=await this.store.load(filters.snapshotId,actor.actorId,key,payload=>this.read(async db=>this.permission(db,await this.liveActor(db,actor),[...payload.result.rows.map(row=>row.line.orderId),...payload.result.unknown.map(row=>row.orderId)],payload.result.windows.map(row=>row.window.id),payload.result.reworks.map(row=>row.reworkId))));
   return this.page({...stored,filters:applied,freshness:'previous-query'},filters.page,exportAll);
  }
  const observation=observedBusinessTime(),clock=new ContextBusinessClock(this.database),observed:Array<{id:string;time:Awaited<ReturnType<ContextBusinessClock['read']>>}>=[];
  const result=await this.read(async db=>{
   const live=await this.liveActor(db,actor),policy=new DigitalProductionAccessPolicy(db),orders=[];
   if(applied.secondaryMerchandiserId&&!isRootActor(live)&&!(live.authorizationCapabilities??[]).includes('sourcing:view'))digitalForbidden();
   // No creation-period cut: old unfinished production stays in the current set.
   const candidates=(await db.query<StatisticsOrder>(`SELECT o.*,s.created_by AS source_creator,s.created_at AS source_created_at,
    CASE WHEN s.source_id IS NOT NULL AND NOT access_is_root_actor(s.created_by) AND EXISTS(SELECT 1 FROM user_role_assignments a
     WHERE a.user_id=s.created_by AND a.role_code='sample_designer' AND a.granted_at<=s.created_at AND(a.revoked_at IS NULL OR a.revoked_at>s.created_at)) THEN s.created_by END AS verified_designer
    FROM digital_production_orders o LEFT JOIN digital_production_sources s USING(source_id) ORDER BY o.production_order_id`)).rows;
   for(const order of candidates)if(await acceptanceIncludesNative(this.database,order.production_order_id)&&await policy.allowed(live,'order',order.production_order_id,'technical')){
    if(applied.customer&&order.customer_code!==applied.customer)continue;
    orders.push(order);
   }
   const rows:StatisticsPo[]=[];for(const order of orders){
    const time=await new ContextBusinessClock(this.database,db).read({kind:'order',id:order.production_order_id});
    if(time.scenarioId&&(time.scenarioId!==observation.scenarioId||time.now!==observation.now))throw new ApplicationError('ANALYSIS_CONTEXT_MISMATCH','不同业务场景或时点不能合成同一截面',409);
    observed.push({id:order.production_order_id,time});rows.push(...await this.orderRows(db,live,order));
   }
   const dimensionTests=(row:StatisticsPo)=>[
    ...applied.category?[{key:'category',expected:applied.category,actual:row.category??null}]:[],
    ...applied.salesYear?[{key:'salesYear',expected:applied.salesYear,actual:row.salesYear}]:[],
    ...applied.salesSeries?[{key:'salesSeries',expected:applied.salesSeries,actual:row.salesSeries}]:[],
    ...applied.primaryMerchandiserId?[{key:'primaryMerchandiser',expected:applied.primaryMerchandiserId,actual:row.primaryMerchandiserId}]:[],
    ...applied.designer?[{key:'designer',expected:applied.designer,actual:row.designerId}]:[],
   ];
   const rangeRows=rows.filter(row=>(!applied.lineId||row.lineId===applied.lineId)&&(!applied.secondaryMerchandiserId||row.secondaryMerchandiserIds.includes(applied.secondaryMerchandiserId))&&(!applied.factoryId||row.allocations.some(scope=>scope.current&&scope.quantity>0&&scope.factoryId===applied.factoryId)));
   const missingDimension=rangeRows.filter(row=>dimensionTests(row).some(test=>test.actual===null)&&dimensionTests(row).every(test=>test.actual===null||test.actual===test.expected));
   const selected=rangeRows.filter(row=>dimensionTests(row).every(test=>test.actual===test.expected));

   if(selected.length>5000)throw new ApplicationError('ANALYSIS_RANGE_TOO_LARGE','授权结果超过本次可保存范围，请缩小筛选',409);
   const full=currentProductionStatistics(selected,observation.now,beijingCalendarDate(new Date(observation.now)));
   const selectedOrders=new Set(selected.map(row=>row.orderId)),motherScope=rows.filter(row=>selectedOrders.has(row.orderId)),motherCompletion=motherScope.length===selected.length?full.metrics.completedOrders:currentProductionStatistics(motherScope,observation.now,full.businessDate).metrics.completedOrders;
   full.metrics.completedOrders=scopedMotherCompletion(motherCompletion,full.rows);
   if(missingDimension.length){const unknown=missingDimension.map(row=>({key:'filter-dimension',orderId:row.orderId,lineId:row.lineId,reason:'已授权对象的筛选维度缺可信映射：'+dimensionTests(row).filter(test=>test.actual===null).map(test=>({category:'品类',salesYear:'销售年度',salesSeries:'P系列',primaryMerchandiser:'主跟单',designer:'设计主责'}[test.key]??test.key)).join('、')+'；不能假定不属于本次筛选',sourceRefs:row.quantitySourceRefs}));full.unknown.push(...unknown);for(const metric of Object.values(full.metrics)){metric.value=null;metric.unknown.push(...unknown);}}
   if(applied.factoryId){full.factories=full.factories.filter(factory=>factory.factoryId===applied.factoryId);full.materials=full.materials.filter(material=>material.requirement.factoryId===applied.factoryId);full.workload=full.workload.filter(item=>item.factoryId===null||item.factoryId===applied.factoryId);}const permissionHash=await this.permission(db,live,[...selected,...missingDimension].map(row=>row.orderId),full.windows.map(row=>row.window.id),full.reworks.map(row=>row.reworkId));
   return {permissionHash,payload:{projectionInputs:selected,motherCompletion,watermark:hash(full),filters:applied,canExport:this.exportAllowed(live),total:full.rows.length,result:full,dimensions:[{key:'customer',available:true,reason:'原订单客户代码；未把客户自动映射为品牌'},{key:'category',available:true,reason:'原当前有效已发布制单品类，缺件仍保留全局数量'},{key:'designer',available:true,reason:'原开发归属加创建时设计角色证据；Root创建未猜设计主责'},{key:'secondaryMerchandiser',available:isRootActor(live)||(live.authorizationCapabilities??[]).includes('sourcing:view'),reason:'沿原外发读取权限及第二跟单字段'}],limitations:['本次为当前生产完整读取，不按创建月份剔除旧积压。','各工厂涉及母单/PO及全PO背景需求不可跨厂相加。','未知归厂只限制相关厂指标；装箱为本系统出货，不代客户签收。','未核历史范围不能提供严格首次合格率或全周期等待覆盖。']}};
  });
  for(const {id,time} of observed)await assertBusinessClockUnchanged(clock,{kind:'order',id},time);
  const currentPermission=await this.read(async db=>this.permission(db,await this.liveActor(db,actor),[...result.payload.result.rows.map(row=>row.line.orderId),...result.payload.result.unknown.map(row=>row.orderId)],result.payload.result.windows.map(row=>row.window.id),result.payload.result.reworks.map(row=>row.reworkId)));
  if(currentPermission!==result.permissionHash)throw new ApplicationError('ANALYSIS_PERMISSION_CHANGED','读取期间授权范围已变化，请重新读取',409);
  const saved=await this.store.save(actor.actorId,key,result.permissionHash,result.payload);
  return this.page({...result.payload,...saved,freshness:'current'},filters.page,exportAll);
 }
 private page(value:Omit<ProductionStatisticsResponse,'page'|'pageSize'|'basis'>&{projectionInputs:StatisticsPo[];motherCompletion:StatisticsMetric},page:number,exportAll:boolean):ProductionStatisticsResponse{
  const {projectionInputs,motherCompletion,...publicValue}=value,result=productionResultProjection(value.result,value.filters,projectionInputs,motherCompletion),groups=productionGroups(result,projectionInputs,motherCompletion,value.filters.groupBy??['factory','customer','stage'],value.filters),facets=productionFacets(value.result);
  return {...publicValue,groups,facets,basis:{total:value.result.rows.length,metrics:value.result.metrics,unknown:value.result.unknown},total:result.rows.length,page,pageSize:15,result:{...result,rows:exportAll?result.rows:result.rows.slice((page-1)*15,page*15)}};
 }
 private async orderRows(db:PoolClient,actor:TrustedActorContext,order:StatisticsOrder):Promise<StatisticsPo[]>{
  const id=order.production_order_id as string,policy=new DigitalProductionAccessPolicy(db),closure=await new OrderClosureService(this.database).read(actor,id,db),gates=await new BulkPreparationService(this.database).gates(db,id);
  const scopeRows=await factoryProductionScopes(db,id,{includeZero:true}),sourceRefs=[`order:${id}:v${order.version}`,`effective-receiving-packing:${closure.revision}`];
  const lines=(await db.query('SELECT line_id,customer_warehouse_arrival_date::text AS customer_date,customer_date_version FROM digital_production_po_lines WHERE production_order_id=$1 ORDER BY position',[id])).rows;
  const lifecycle=(await db.query("SELECT state FROM digital_production_resource_lifecycle WHERE(resource_kind='order' AND resource_id=$1) OR(resource_kind='source' AND resource_id=$2)",[id,order.source_id])).rows;
  const state=lifecycle.some(row=>row.state==='cancelled')?'cancelled':lifecycle.some(row=>row.state==='paused')?'paused':'active';
  const secondary=isRootActor(actor)||(actor.authorizationCapabilities??[]).includes('sourcing:view')?(await db.query(`SELECT s.additional_merchandiser_user_id FROM digital_production_child_links l JOIN sourcing_cases s ON s.sourcing_case_id=l.child_id WHERE l.production_order_id=$1 AND l.module='sourcing' AND s.deleted_at IS NULL`,[id])).rows.flatMap(row=>row.additional_merchandiser_user_id?[row.additional_merchandiser_user_id as string]:[]):[];
  const retired=await retiredBulkPreshrinkTaskIds(db),rawTasks=(await db.query(`SELECT t.*,a.assignee_id,assignee.display_name AS assignee_name,r.due_at,r.policy_version,r.deadline_kind,policy.label AS task_label
   FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) LEFT JOIN app_users assignee ON assignee.id=a.assignee_id
   LEFT JOIN LATERAL(SELECT * FROM digital_production_deadline_revisions WHERE task_id=t.task_id ORDER BY revision_id DESC LIMIT 1)r ON true
   LEFT JOIN LATERAL(SELECT label FROM digital_production_deadline_policies WHERE node_key=t.node_key ORDER BY version DESC LIMIT 1)policy ON true
   WHERE a.production_order_id=$1 AND a.task_kind<>'factory_material_count' AND NOT(t.task_id=ANY($2::uuid[])) ORDER BY t.task_id`,[id,retired])).rows;
  const visible=[];for(const task of rawTasks)if(await policy.allowed(actor,'task',task.task_id,'technical'))visible.push(task);
  const events=(await db.query(`SELECT event_id AS id,task_id AS "taskId",event_kind AS kind,occurred_at AS at,recorded_at AS "recordedAt",time_quality AS quality,actor_id AS "actorId",corrects_event_id AS "correctsId",payload
   FROM digital_production_task_events WHERE task_id=ANY($1::uuid[]) ORDER BY recorded_at,event_id`,[visible.map(task=>task.task_id)])).rows.map(event=>({...event,at:event.at?new Date(event.at).toISOString():null,recordedAt:new Date(event.recordedAt).toISOString()}));
  const windows:StatisticsWindow[]=[],problems:StatisticsProblem[]=[];
  for(const task of visible){
   const taskEvents=events.filter(event=>event.taskId===task.task_id),model:AnalysisTask={taskId:task.task_id,sourceId:order.source_id??null,orderId:id,styleNo:order.design_style_no,customer:order.customer_code,category:'',requiredRole:'',assigneeId:task.assignee_id??null,assigneeName:task.assignee_name??null,nodeKey:task.node_key,label:task.task_label??task.node_key,round:task.route_version,state:task.state,createdAt:new Date(task.created_at).toISOString(),sourceRound:null,instructionVersion:null,enteredAt:task.entered_at?new Date(task.entered_at).toISOString():null,completedAt:task.completed_at?new Date(task.completed_at).toISOString():null,enteredQuality:task.entered_quality,completedQuality:task.completed_quality,dueAt:task.due_at?new Date(task.due_at).toISOString():null,policyVersion:task.policy_version??null,pendingConditions:[],sourceCreatedAt:null,sourcePublished:false,events:taskEvents};
   const analysis=taskAnalysis(model,observedBusinessTime().now);
   windows.push({id:task.task_id,orderId:id,lineIds:[],nodeKey:task.node_key,label:model.label,version:String(task.policy_version??task.route_version),state:state==='paused'&&!['completed','cancelled'].includes(task.state)?'paused':task.state,assigneeId:task.assignee_id??null,assigneeName:task.assignee_name??null,independent:task.due_at!==null,excludedReason:state==='cancelled'?'原所属母单或开发来源已取消':closure.closed?'原母单特殊结案':task.state==='cancelled'?'原任务已取消':null,entered:at(task.entered_at,`task:${task.task_id}:entered`,['现场登记','已核实'].includes(task.entered_quality)),completed:at(task.completed_at,`task:${task.task_id}:completed`,['现场登记','已核实'].includes(task.completed_quality)),deadline:model.dueAt,deadlineExclusive:task.deadline_kind==='date_target',waits:analysis.waitingIntervals.map(([from,to],index)=>({id:`${task.task_id}:known-wait:${index}`,from:new Date(from).toISOString(),to:new Date(to).toISOString(),verified:true})),waitingCoverage:analysis.waitingIntervals.length?'partial':'unknown',sourceRefs:[`task:${task.task_id}:route${task.route_version}`]});
   let open:StatisticsProblem|undefined,lastResolved:StatisticsProblem|undefined;
   for(const event of taskEvents.filter(event=>!event.correctsId)){
    if(event.kind==='blocked'&&!open){open={id:`blocked:${event.id}`,orderId:id,lineIds:[],kind:'原任务明确阻断',blocking:true,reasonCode:null,description:String(event.payload.reason??event.payload.note??task.blocked_reason??'原任务阻断原因未登记'),state:'current',occurred:at(event.at,`task-event:${event.id}`,['现场登记','已核实'].includes(event.quality)),observed:none(),recorded:at(event.recordedAt,`task-event:${event.id}:recorded`),resolved:none(),recurrenceOf:lastResolved?.id??null,sourceRefs:[`task-event:${event.id}`]};problems.push(open);}
    else if(open&&['unblocked','completed','cancelled','cancel'].includes(event.kind)){open.state=event.kind==='unblocked'?'resolved':'unknown';open.resolved=event.kind==='unblocked'?at(event.at,`task-event:${event.id}`,['现场登记','已核实'].includes(event.quality)):none();open.sourceRefs.push(`task-event:${event.id}`);if(open.state==='resolved')lastResolved=open;open=undefined;}
   }
   if(task.state==='blocked'&&!open)problems.push({id:`blocked-current:${task.task_id}`,orderId:id,lineIds:[],kind:'原任务明确阻断',blocking:true,reasonCode:null,description:task.blocked_reason??'原任务明确阻断，原因未登记',state:'current',occurred:none(),observed:none(),recorded:none(),resolved:none(),recurrenceOf:null,sourceRefs:[`task:${task.task_id}:current-state`]});
  }
  const workload:StatisticsWorkload[]=windows.map(window=>({id:window.id,orderId:id,lineIds:window.lineIds,kind:'task',nodeKey:window.nodeKey,label:window.label,state:window.state,assigneeId:window.assigneeId,assigneeName:window.assigneeName??null,factoryId:null,factoryName:null,active:!window.excludedReason&&!['completed','cancelled','unknown'].includes(window.state),excludedReason:window.excludedReason??(['completed','cancelled'].includes(window.state)?'原任务已结束，不纳当前负荷':null),sourceRefs:window.sourceRefs}));
  const executions=new Map<string,typeof scopeRows>();for(const scope of scopeRows.filter(scope=>Number(scope.quantity)>0)){const key=`${scope.production_order_id}:${scope.factory_decision_id??'original'}`,group=executions.get(key)??[];group.push(scope);executions.set(key,group);}
  for(const [scopeId,scopes]of executions){const scope=scopes[0]!,ended=['production_completed','shipped'].includes(scope.execution_status),valid=['in_production','production_completed','shipped'].includes(scope.execution_status),excluded=state==='cancelled'?'原母单或来源已取消':closure.closed?'原母单已特殊结案':ended?'原生产执行已结束，不纳当前负荷':null;workload.push({id:'factory-execution:'+scopeId,orderId:id,lineIds:scopes.map(row=>row.line_id as string),kind:'factory-execution',nodeKey:'factory_execution',label:'原工厂生产批次',state:excluded?ended?'completed':'cancelled':!valid?'unknown':state==='paused'?'paused':'active',assigneeId:null,assigneeName:null,factoryId:scope.supplier_id,factoryName:scope.supplier_name_snapshot,active:excluded===null&&valid,excludedReason:excluded,sourceRefs:[`native-production:${scope.production_order_id}:${scope.factory_decision_id??'original'}:state:${scope.execution_status??'missing'}`]});}
  const receiptIds=(closure.quality??[]).map(row=>row.receiptId),receipts=receiptIds.length?(await db.query(`${RECEIVING_ANALYSIS_LINKS_SQL} WHERE receipt.receipt_id=ANY($1::uuid[])`,[receiptIds])).rows:[];
  // Before dispatch use the original effective owner approval; execution allocations,
  // once present, retain the original transfer function, including zero old shares.
  const approved=!scopeRows.length&&gates.approval?(await db.query(`SELECT map.line_id,l.quantity,a.supplier_id,a.supplier_name_snapshot,a.sourcing_decision_id FROM sourcing_approval_snapshots a
   JOIN sourcing_approval_snapshot_lines l USING(sourcing_approval_snapshot_id) JOIN digital_production_child_lines map ON map.module='sourcing' AND map.child_id=a.sourcing_case_id AND map.child_line_key=l.position::text
   WHERE a.sourcing_approval_snapshot_id=$1`,[gates.approval.sourcing_approval_snapshot_id])).rows:[];
  const materialFacts=await productionMaterialFacts(db,id,gates);
  const executionCoverage=(await db.query(`SELECT count(*)::int AS expected,count(mapping.line_id)::int AS mapped
   FROM digital_production_child_links link JOIN sourcing_production_factory_orders production ON production.production_order_id=link.child_id
   CROSS JOIN LATERAL sourcing_factory_execution_lines(production.production_order_id,production.sourcing_decision_id) execution
   LEFT JOIN digital_production_child_lines mapping ON mapping.module='production' AND mapping.child_id=production.production_order_id AND mapping.child_line_key=execution.position::text
   WHERE link.module='production' AND link.production_order_id=$1`,[id])).rows[0]!,hasExecution=Boolean((await db.query("SELECT 1 FROM digital_production_child_links WHERE production_order_id=$1 AND module='production' LIMIT 1",[id])).rowCount);
  const approvalCoverage=!hasExecution&&gates.approval?(await db.query(`SELECT count(*)::int AS expected,count(mapping.line_id)::int AS mapped
   FROM sourcing_approval_snapshot_lines approved JOIN sourcing_approval_snapshots snapshot USING(sourcing_approval_snapshot_id)
   LEFT JOIN digital_production_child_lines mapping ON mapping.module='sourcing' AND mapping.child_id=snapshot.sourcing_case_id AND mapping.child_line_key=approved.position::text
   WHERE approved.sourcing_approval_snapshot_id=$1`,[gates.approval.sourcing_approval_snapshot_id])).rows[0]:null;
  const coverage=hasExecution?executionCoverage:approvalCoverage,allocationComplete=coverage===null||Number(coverage.expected)>0&&Number(coverage.expected)===Number(coverage.mapped);
  return closure.lines.map(line=>{
   const po=lines.find(row=>row.line_id===line.lineId),quality=(closure.quality??[]).filter(row=>row.lineId===line.lineId),allocations:StatisticsPo['allocations']=scopeRows.filter(row=>row.line_id===line.lineId).map(row=>({scopeId:`${row.production_order_id}:${row.factory_decision_id??'original'}:${line.lineId}`,factoryId:row.supplier_id as string,factoryName:row.supplier_name_snapshot as string,quantity:Number(row.quantity),version:row.sourcing_decision_id as string,current:Number(row.quantity)!==0,origin:row.factory_decision_id===null?'original' as const:'transfer' as const,sourceRefs:[`native-factory:${row.production_order_id}:${row.factory_decision_id??'original'}`]}));
   for(const row of approved.filter(row=>row.line_id===line.lineId))allocations.push({scopeId:`approval:${row.sourcing_decision_id}:${line.lineId}`,factoryId:row.supplier_id,factoryName:row.supplier_name_snapshot,quantity:Number(row.quantity),version:row.sourcing_decision_id,current:true,origin:'approved' as const,sourceRefs:[`owner-approval:${gates.approval.sourcing_approval_snapshot_id}`]});
   const attributions:StatisticsPo['attributions']=[];for(const receipt of receipts.filter(receipt=>quality.some(q=>q.receiptId===receipt.receipt_id)&&!receipt.archived&&!receipt.excluded)){
    // NULL is the original execution, not today's selected supplier. A receipt
    // factory is resolved from its immutable original production/transfer relation.
    const scopes=scopeRows.filter(scope=>scope.production_order_id===receipt.production_order_id&&scope.factory_decision_id===receipt.factory_decision_id),factoryId=scopes.length&&new Set(scopes.map(scope=>scope.supplier_id)).size===1?scopes[0]!.supplier_id as string:null,q=quality.find(q=>q.receiptId===receipt.receipt_id)!;
    attributions.push({scopeId:receipt.receipt_id,quantityVersion:q.quantityVersion,current:true,factoryId,quantity:Number(receipt.actual_quantity),kind:'received',sourceRefs:[`receipt:${receipt.receipt_id}:factory-link`]});if(q.inspected)attributions.push({scopeId:receipt.receipt_id,quantityVersion:q.quantityVersion,current:true,factoryId,quantity:q.qualifiedQuantity,kind:'qualified',sourceRefs:[`warehouse-QC:${q.eventId}`]});
   }
   return {orderId:id,lineId:line.lineId,poNumber:line.poNumber,color:line.color,customerCode:order.customer_code,productGroup:order.product_group,category:gates.instructionValid?gates.instruction?.document.category??null:null,sourceId:order.source_id??null,salesYear:order.sales_year??null,salesSeries:order.sales_series??null,primaryMerchandiserId:order.primary_merchandiser_id??null,designerId:order.verified_designer??null,secondaryMerchandiserIds:secondary,customerDate:po?.customer_date??null,quantityVersion:hash([order.version,line.lineId,line.orderedQuantity]),demand:line.orderedQuantity,received:line.cuttingId||!line.receipts.length?line.actualQuantity:null,packing:line.packingQuantity??0,packingRevision:line.packingRevisionId,quantitySourceRefs:[...sourceRefs,`customer-date:${po?.customer_date_version??'missing'}`],quality:quality.map(q=>({scopeId:q.receiptId,quantityVersion:q.quantityVersion,quantity:q.quantity,inspected:q.inspected,qualified:q.qualifiedQuantity,sourceRefs:[`warehouse-QC:${q.eventId??'not-recorded'}`]})),allocations,allocationComplete,attributions,lifecycle:state,specialClosure:Boolean(closure.closed),reworks:line.reworks.filter(rework=>rework.canView&&rework.businessSummary).map(rework=>({reworkId:rework.reworkId,orderId:id,lineId:line.lineId,kind:rework.businessSummary!.kind,status:rework.status,inputQuantity:rework.quantity,roundNumber:null,processes:rework.businessSummary!.processes,distinctGarments:null,firstPassRate:null,unknown:['原返工单及各工序有效报工分别列出；未核同件跨轮身份，不汇总成独立不良件数或严格首次通过率','原读取未提供可核轮次编号，不能按返回顺序造轮次'],sourceRefs:[`rework:${rework.reworkId}:current-effective-process-reports`]})),problems,windows,workload,materials:[...materialFacts.whole,...materialFacts.forPo(line.lineId,line.orderedQuantity,allocations)]};
  });
 }
}
