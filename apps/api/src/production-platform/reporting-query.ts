import {assertBusinessClockUnchanged,ContextBusinessClock} from '../acceptance-clock/business-time.js';
import {validateBusinessTime,type BusinessTime,type BusinessTimeScope} from '@dx-rework/domain/business-clock';
import {randomUUID,createHash} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import type {DigitalAnalysisFilters,DigitalAnalysisNote,DigitalAnalysisResult} from '@dx-rework/contracts/digital-production-analysis';
import type {TrustedActorContext} from '../tools/repositories.js';
import {DigitalProductionAccessPolicy,isDigitalLeader,isDigitalManagementReader,isDigitalTechnicalManager,digitalForbidden} from './access-policy.js';
import {assertIdentityActor} from './identity-service.js';
import {assertBusinessExportAllowed} from '../access/export-authority.js';
import {ApplicationError} from '../platform/errors.js';
import {buildWorkbook,type WorkbookCell} from '../reporting/xlsx-workbook.js';
import {ANALYSIS_RULE_VERSION,taskAnalysis,summarizeAnalysis,type AnalysisTask} from './reporting-metrics.js';
import {workspaceAnalysisRows,analysisWorkspaceOverview,WORKSPACE_ANALYSIS_RULE_VERSION} from './analysis-workspace-metrics.js';
import {materialReadiness} from './development-material-readiness.js';
import {ProductionStatisticsQuery} from './production-statistics-query.js';
import {productionEvidenceSheets} from './production-statistics-export.js';
const iso=(value:Date|string|null)=>value===null?null:new Date(value).toISOString();
const range=(filters:DigitalAnalysisFilters)=>({from:new Date(`${filters.from}T00:00:00+08:00`).toISOString(),to:new Date(Date.parse(`${filters.to}T00:00:00+08:00`)+86400000).toISOString()});
export class DigitalAnalysisQuery{
 private readonly observations=new WeakMap<PoolClient,Map<string,{scope:BusinessTimeScope;time:BusinessTime}>>();
 constructor(private readonly database:Pool){}
 async production(actor:TrustedActorContext,filters:DigitalAnalysisFilters){return new ProductionStatisticsQuery(this.database).list(actor,filters);}
 private exportAllowed(actor:TrustedActorContext){try{assertBusinessExportAllowed(actor.actorRoles,'report:export');return isDigitalLeader(actor)&&actor.actorRoles.includes('root_superuser')||Boolean(actor.authorizationCapabilities?.includes('report:view'));}catch{return false;}}
 private async snapshot(db:PoolClient,actor:TrustedActorContext,filters:DigitalAnalysisFilters){
  assertIdentityActor(actor);const window=range(filters),asOf=new Date().toISOString();
  const candidates=(await db.query(`SELECT t.task_id AS "taskId",coalesce(a.source_id,bp.source_id,o.source_id) AS "sourceId",a.production_order_id AS "orderId",
    coalesce(o.design_style_no,s.design_style_no) AS "styleNo",coalesce(o.customer_code,s.customer_code,'') AS customer,coalesce(d.document->>'template','') AS category,
    a.required_role AS "requiredRole",a.assignee_id AS "assigneeId",u.display_name AS "assigneeName",t.node_key AS "nodeKey",p.label,t.route_version AS round,t.state,
    CASE WHEN a.source_id IS NOT NULL THEN t.route_version ELSE bp.source_round END AS "sourceRound",bp.instruction_version AS "instructionVersion",
    t.created_at AS "createdAt",t.entered_at AS "enteredAt",t.completed_at AS "completedAt",t.entered_quality AS "enteredQuality",t.completed_quality AS "completedQuality",
    ARRAY(SELECT condition_key FROM digital_production_task_conditions WHERE task_id=t.task_id AND NOT satisfied AND condition_key IN ('materials_ready','handover_received')) AS "pendingConditions",
    r.due_at AS "dueAt",COALESCE(r.deadline_kind,'duration') AS "deadlineMode",r.policy_version AS "policyVersion",s.created_at AS "sourceCreatedAt",d.published_at AS "sourcePublishedAt",coalesce(d.status='published',false) AS "sourcePublished"
    FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id)
    LEFT JOIN digital_production_orders o ON o.production_order_id=a.production_order_id
    LEFT JOIN digital_bulk_preparations bp ON bp.preparation_id=t.route_instance_id AND bp.production_order_id=a.production_order_id
    LEFT JOIN digital_production_sources s ON s.source_id=coalesce(a.source_id,bp.source_id,o.source_id)
    LEFT JOIN digital_development_documents d ON d.source_id=s.source_id
    LEFT JOIN app_users u ON u.id=a.assignee_id
    JOIN LATERAL(SELECT label FROM digital_production_deadline_policies WHERE node_key=t.node_key ORDER BY version DESC LIMIT 1)p ON true
    LEFT JOIN LATERAL(SELECT due_at,policy_version,to_jsonb(digital_production_deadline_revisions)->>'deadline_kind' AS deadline_kind FROM digital_production_deadline_revisions WHERE task_id=t.task_id ORDER BY revision_id DESC LIMIT 1)r ON true
    WHERE ($1='' OR coalesce(o.customer_code,s.customer_code)=$1)
      AND ($2='' OR d.document->>'template'=$2) AND ($3='' OR a.required_role=$3) AND ($4::uuid IS NULL OR s.created_by=$4)
      AND (($7::text IS NULL AND t.created_at>=$5 AND t.created_at<$6) OR ($7::text IS NOT NULL AND (
        t.state NOT IN ('completed','cancelled')
        OR (t.state='completed' AND t.completed_at>=$5 AND t.completed_at<$6)
        OR (d.published_at>=$5 AND d.published_at<$6)
        OR ($7='created' AND t.created_at>=$5 AND t.created_at<$6)
        OR EXISTS(SELECT 1 FROM digital_development_rounds period_round WHERE period_round.source_id=s.source_id
          AND period_round.round_number=CASE WHEN a.source_id IS NOT NULL THEN t.route_version ELSE bp.source_round END
          AND period_round.published_at>=$5 AND period_round.published_at<$6)
      )))
    ORDER BY t.created_at DESC,t.task_id DESC`,[filters.customer,filters.category,filters.role,filters.designer??null,window.from,window.to,filters.scope??null])).rows;
  const policy=new DigitalProductionAccessPolicy(db),authorized=[];
  for(const row of candidates)if(await policy.allowed(actor,'task',row.taskId,'technical'))authorized.push(row);
  const ids=authorized.map(row=>row.taskId);
  const supplyTasks=authorized.filter(row=>row.nodeKey==='development_material_supply'&&!['completed','cancelled'].includes(row.state));
  const missingSupplyRounds=new Set<string>();
  const supplyRounds=new Map(supplyTasks.map(row=>[`${row.sourceId}:${row.round}`,row]));
  for(const [key,row]of supplyRounds)if((await materialReadiness(db,row.sourceId,row.round)).supplyMissing.length)missingSupplyRounds.add(key);
  const events=(await db.query(`SELECT event_id AS id,task_id AS "taskId",event_kind AS kind,occurred_at AS at,recorded_at AS "recordedAt",time_quality AS quality,actor_id AS "actorId",u.display_name AS "actorName",corrects_event_id AS "correctsId",payload
    FROM digital_production_task_events e JOIN app_users u ON u.id=e.actor_id WHERE task_id=ANY($1::uuid[]) ORDER BY recorded_at,event_id`,[ids])).rows;
  const assignments=(await db.query(`SELECT a.entity_id AS "taskId",a.created_at AS at,u.display_name AS "actorName",previous_user.display_name AS "beforeName",next_user.display_name AS "afterName"
    FROM audit_events a JOIN app_users u ON u.id=a.actor_id LEFT JOIN app_users previous_user ON previous_user.id=(a.before_state->>'assigneeId')::uuid LEFT JOIN app_users next_user ON next_user.id=(a.after_state->>'assigneeId')::uuid
    WHERE a.action='digital_task_reassigned' AND a.entity_id=ANY($1::text[]) ORDER BY a.created_at,a.id`,[ids])).rows;
  const delegations=(await db.query(`SELECT d.task_id AS "taskId",u.display_name AS name,d.created_at AS "from",d.expires_at AS "expiresAt",d.revoked_at AS "revokedAt"
    FROM digital_production_delegations d JOIN app_users u ON u.id=d.delegate_id WHERE d.task_id=ANY($1::uuid[]) AND d.purpose='execute' ORDER BY d.created_at,d.delegation_id`,[ids])).rows;
  const times=new Map<string,BusinessTime>(),clock=new ContextBusinessClock(this.database,db);
  for(const row of authorized){
   const scope:BusinessTimeScope|null=row.orderId?{kind:'order',id:row.orderId}:row.sourceId?{kind:'source',id:row.sourceId}:null;
   if(!scope)throw new ApplicationError('CONFLICT','任务缺少可验证的原业务归属',409);
   const key=`${scope.kind}:${scope.id}`;
   if(!times.has(key)){const time=validateBusinessTime(await clock.read(scope));times.set(key,time);if(time.scenarioId)this.observations.get(db)?.set(key,{scope,time});}
  }
  const rows=authorized.map(row=>taskAnalysis({...row,businessTime:times.get(`${row.orderId?'order':'source'}:${row.orderId??row.sourceId}`)!,materialSupplyPending:row.nodeKey==='development_material_supply'&&missingSupplyRounds.has(`${row.sourceId}:${row.round}`),createdAt:iso(row.createdAt)!,enteredAt:iso(row.enteredAt),completedAt:iso(row.completedAt),dueAt:iso(row.dueAt),sourceCreatedAt:iso(row.sourceCreatedAt),sourcePublishedAt:iso(row.sourcePublishedAt),events:events.filter(e=>e.taskId===row.taskId).map(e=>({...e,at:iso(e.at),recordedAt:iso(e.recordedAt)!}))} as AnalysisTask,asOf));
  const attributedRows=rows.map(row=>({...row,assignmentHistory:assignments.filter(a=>a.taskId===row.taskId).map(a=>({...a,at:iso(a.at)!})),delegations:delegations.filter(d=>d.taskId===row.taskId).map(d=>({...d,from:iso(d.from)!,expiresAt:iso(d.expiresAt)!,revokedAt:iso(d.revokedAt)}))}));
  const people=[...new Map(attributedRows.filter(row=>row.assigneeId).map(row=>[row.assigneeId!,{id:row.assigneeId!,name:row.assigneeName}])).values()];
  const scopedRows=filters.assigneeId?attributedRows.filter(row=>row.assigneeId===filters.assigneeId):attributedRows;
  // Match original development reads: any technically visible source task grants
  // the read, including tasks outside the current analysis filters.
  const candidateSources=[...new Set(scopedRows.map(row=>row.sourceId).filter((id):id is string=>Boolean(id)))];
  const sourceTasks=(await db.query('SELECT task_id,source_id FROM digital_production_task_access WHERE source_id=ANY($1::uuid[])',[candidateSources])).rows;
  const sourceIds:string[]=[];
  for(const sourceId of candidateSources){
    let readable=await policy.allowed(actor,'source',sourceId,'technical');
    if(!readable)for(const task of sourceTasks)if(task.source_id===sourceId&&await policy.allowed(actor,'task',task.task_id,'technical')){readable=true;break;}
    if(readable)sourceIds.push(sourceId);
  }
  const rawRounds=(await db.query(`SELECT source_id AS "sourceId",round_number AS round,origin,categories,affected_nodes AS "affectedNodes",customer_comment AS "customerComment",internal_problem AS "internalProblem",explanation,published_at AS "publishedAt" FROM digital_development_rounds
    WHERE source_id=ANY($1::uuid[]) AND published_at>=$2 AND published_at<$3 ORDER BY published_at,source_id,round_number`,[sourceIds,window.from,window.to])).rows;
  const rounds=rawRounds.map(row=>({...row,publishedAt:iso(row.publishedAt)!}));
  const readableSources=new Set(sourceIds);
  const selectedRows=workspaceAnalysisRows(scopedRows,rounds,filters,window.from,window.to,asOf).map(row=>({
    ...row,canReadSourceRound:row.sourceRound!=null&&readableSources.has(row.sourceId??''),
  }));
  // Shared analysis is readable only when every referenced original task remains visible.
  const rawNotes=(await db.query(`SELECT a.id,u.display_name AS author,a.created_at AS "createdAt",a.after_state AS note FROM audit_events a JOIN app_users u ON u.id=a.actor_id
    WHERE a.action='digital.analysis.recorded' AND (a.actor_id=$1 OR $2::boolean) ORDER BY a.created_at DESC,a.id DESC LIMIT 100`,[actor.actorId,isDigitalManagementReader(actor)||isDigitalTechnicalManager(actor)])).rows;
  const notes=[];
  for(const record of rawNotes){const note=record.note as DigitalAnalysisNote&{ruleVersion:string};let allowed=true;for(const id of note.taskIds)if(!await policy.allowed(actor,'task',id,'technical')){allowed=false;break;}if(allowed)notes.push({id:record.id,author:record.author,createdAt:iso(record.createdAt)!,...note});}
  return {ruleVersion:filters.scope?WORKSPACE_ANALYSIS_RULE_VERSION:ANALYSIS_RULE_VERSION,asOf,filters,canExport:this.exportAllowed(actor),canRecord:isDigitalLeader(actor)||isDigitalTechnicalManager(actor),page:filters.page,total:selectedRows.length,
    summary:summarizeAnalysis(selectedRows,window.from,window.to),people,overview:analysisWorkspaceOverview(scopedRows,window.from,window.to,asOf),rounds,rows:selectedRows,notes};
 }
 private async read<T>(action:(db:PoolClient)=>Promise<T>){
  const db=await this.database.connect(),observations=new Map<string,{scope:BusinessTimeScope;time:BusinessTime}>();this.observations.set(db,observations);let result:T;
  try{await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');result=await action(db);await db.query('COMMIT');}catch(e){await db.query('ROLLBACK');throw e;}finally{this.observations.delete(db);db.release();}
  for(const {scope,time} of observations.values())await assertBusinessClockUnchanged(new ContextBusinessClock(this.database),scope,time);
  return result;
 }

 async list(actor:TrustedActorContext,filters:DigitalAnalysisFilters):Promise<DigitalAnalysisResult>{return this.read(async db=>{const all=await this.snapshot(db,actor,filters);return {...all,rows:all.rows.slice((filters.page-1)*15,filters.page*15)};});}
 async export(actor:TrustedActorContext,filters:DigitalAnalysisFilters){
  if(!this.exportAllowed(actor))digitalForbidden();
  if(filters.view==='production'){
   if(!filters.snapshotId)throw new ApplicationError('ANALYSIS_RESULT_REQUIRED','请先读取完整查询结果，再导出该版结果',409);
   const result=await new ProductionStatisticsQuery(this.database).list(actor,filters,true);
   if(!result.canExport)digitalForbidden();
   const value=(number:number|null)=>number===null?'未知':number;
   const labels:Record<string,string>={orders:'母单数',pos:'PO数',demand:'涉及PO总需求',received:'有效实收',qualityCovered:'到仓质量检查覆盖',qualified:'到仓合格',qualityMissing:'到仓检查覆盖缺口',packed:'装箱出货',remaining:'涉及PO的客户待出货',excess:'超量装箱',completedOrders:'已装齐母单',completedPos:'已装齐PO',unallocated:'未覆盖选厂量',duePos:'客户约定已过且未装齐PO',dueQuantity:'客户约定已过的待出货量',nextSevenPos:'未来七日应出货未齐PO',nextSevenQuantity:'未来七日应出货未齐量',missingCustomerDatePos:'客户约定日期缺件PO',blockedPos:'当前明确阻断涉及PO',blockedOrders:'当前明确阻断涉及母单',currentProblems:'当前独立问题数',cancelledOrders:'已取消母单',specialClosureOrders:'特殊结案母单'};
   const filterLabels:Record<string,string>={from:'日期自',to:'日期至',customer:'客户',category:'品类',page:'原页码',view:'查询内容',factoryId:'工厂范围',lineId:'PO范围',salesYear:'销售年度',salesSeries:'P系列',primaryMerchandiserId:'主跟单',secondaryMerchandiserId:'第二跟单',designer:'设计主责',drillLineId:'同版下钻PO',drillOrderId:'同版下钻母单',drillFactoryId:'同版下钻工厂',drillMetric:'同版下钻指标',drillFactories:'同版工厂多选（同维取并集）',drillCustomers:'同版客户多选（同维取并集）',drillStages:'同版节点多选（同维取并集）',drillStageFactories:'节点分组时的工厂范围（空列表为整PO）',groupBy:'分组顺序'};
   const kindLabels={received:'有效实收',qualified:'到仓合格',packed:'装箱出货'};
   const content=await buildWorkbook([{name:'范围与口径',rows:[['查询结果',result.snapshotId],['业务观察',result.result.asOf],['生成',result.createdAt],['有效至',result.expiresAt],['结果状态',result.freshness==='current'?'本次完整读取':'已保存查询结果，以原观察时点为准'],['口径版',result.result.ruleVersion],['数据水位',result.watermark],['完整读取PO数',result.basis.total],['本次下钻PO数',result.total],...Object.entries(result.filters).filter(([,value])=>value!==undefined&&value!=='').map(([key,value])=>[filterLabels[key]??'已应用条件',key==='drillMetric'?({all:'全部有权范围',backlog:'当前在产未装齐','next-seven':'未来七日应出货未齐','past-due':'已过客户交期未齐',blocked:'原明确阻断涉及范围','quality-gap':'到仓检查覆盖缺口',unknown:'具体缺件范围',unallocated:'选厂未覆盖或范围待核',completed:'普通数量已完成',cancelled:'已取消',special:'特殊结案'}[String(value)]??'指标待核'):value==='production'?'当前生产':Array.isArray(value)?JSON.stringify(key==='groupBy'?value.map(key=>({factory:'工厂',customer:'客户',stage:'节点'}[key]??key)):value):String(value)]),...result.limitations.map(line=>['说明',line])]},
    {name:'数量汇总',rows:[['指标','完整值','已核范围值','单位','具体未知'],...Object.entries(result.result.metrics).map(([key,metric])=>[labels[key]??key,value(metric.value),metric.knownValue,metric.unit,metric.unknown.map(item=>item.reason).join('；')])]},
    {name:'PO明细',rows:[['母单','PO实体','PO','颜色','客户','销售年','P系列','需求','有效实收','到仓检查覆盖','合格','质量缺口','装箱出货','客户待出货','超量','未覆盖选厂','客户约定','数量完成','质量完整','业务有效性','特殊结案','具体未知'],...result.result.rows.map(row=>[row.line.orderId,row.line.lineId,row.line.poNumber??'',row.line.color,row.line.customerCode,row.line.salesYear??'',row.line.salesSeries??'',value(row.line.demand),value(row.line.received),value(row.qualityCovered),value(row.qualified),value(row.qualityMissing),value(row.line.packing),value(row.remaining),value(row.excess),value(row.unallocated),row.line.customerDate??'',row.quantityComplete===null?'未知':row.quantityComplete?'已装齐':'未装齐',row.qualityComplete===null?'未知':row.qualityComplete?'完整':'存在缺口',({active:'正常生产',paused:'已暂停',cancelled:'已取消',unknown:'有效性待核'}[row.line.lifecycle]),row.line.specialClosure?'是':'否',row.unknown.map(item=>item.reason).join('；')])]},
    {name:'工厂范围',rows:[['工厂','本厂承接','涉及PO总需求（不可加）','涉及PO客户待出货（非本厂欠交）','本厂已核归属实收','本厂真实实收','本厂真实装箱','本厂欠交','未知原因'],...result.result.factories.map(factory=>[factory.factoryName,value(factory.allocated),value(factory.involvedPoDemand),value(factory.involvedPoCustomerRemaining),factory.knownAttributed.received,value(factory.actual.received),value(factory.actual.packed),value(factory.remaining),[factory.excludedReason,...factory.attributionUnknown.map(item=>item.reason)].filter(Boolean).join('；')])]},
    ...productionEvidenceSheets(result),
    {name:'完整分组',rows:[['分组路径','涉及母单（不可加）','涉及PO（不可加）','涉及PO总需求','本厂承接','本厂实收','本厂装箱','涉及PO客户待出货背景','具体未知'],...(result.groups??[]).map(group=>[group.path.map(item=>item.label).join(' › '),value(group.metrics.orders.value),value(group.metrics.pos.value),value(group.metrics.demand.value),group.factory?value(group.factory.allocated):'无单一已核厂份额',group.factory?value(group.factory.actual.received):'不分摊',group.factory?value(group.factory.actual.packed):'不分摊',value(group.metrics.remaining.value),[...group.unknown,...(group.factory?.attributionUnknown??[])].map(item=>item.reason).join('；')])]},
    {name:'具体缺件依据',rows:[['原母单','原PO实体','影响范围','具体缺件'],...[...new Map([...result.result.unknown,...result.basis.unknown].map(item=>[JSON.stringify(item),item])).values()].map(item=>[item.orderId,item.lineId??'原母单范围',item.key==='filter-dimension'?'筛选维度':labels[item.key]??'原指标范围',item.reason])]},
    {name:'未知归厂池',rows:[['母单','PO实体','指标','数量（全局一次）','说明'],...result.result.unattributed.map(pool=>[pool.orderId,pool.lineId,kindLabels[pool.kind],value(pool.quantity),pool.reason])]}]);
   await this.database.query("INSERT INTO audit_events(id,request_id,actor_id,action,entity_type,entity_id,after_state) VALUES($1::uuid,$2,$3,'digital.analysis.exported','digital_analysis',$1::text,$4)",[randomUUID(),actor.requestId,actor.actorId,JSON.stringify({snapshotId:result.snapshotId,filters:result.filters,ruleVersion:result.result.ruleVersion,rowCount:result.total,watermark:result.watermark})]);return content;
  }
  const result=await this.read(db=>this.snapshot(db,actor,filters));
  const rows:WorkbookCell[][]=[['任务','来源','母单','款号','客户','品类','岗位','当前主办','开发轮次','制单版本','节点','状态','进入','完成','时间质量','期限','SLA版本','按期纳入','排除原因','办理秒数','已知等待秒数','等待缺失数','业务观察时刻'],
    ...result.rows.map(r=>[r.taskId,r.sourceId??'',r.orderId??'',r.styleNo,r.customer,r.category,r.requiredRole,r.assigneeName??'',r.sourceRound??'',r.instructionVersion??'',r.label,r.state,r.enteredAt??'',r.completedAt??'',`${r.enteredQuality}/${r.completedQuality}`,r.dueAt??'',r.policyVersion??'',r.slaIncluded?'是':'否',r.exclusion??'',r.handlingSeconds??'',r.waitingSeconds,r.unknownWaiting,r.businessTime?.now??''])];
  const content=await buildWorkbook([{name:'范围与口径',rows:[['规则版本',result.ruleVersion],['生成时间',result.asOf],['统计窗口',filters.scope==='snapshot'?'当前积压快照（不按创建日期排除）':filters.scope==='completed'?'任务原完成日期（北京时间）':filters.scope==='published'?'来源首次原发布日期（北京时间）':filters.scope==='revisions'?'复版原发布日期（北京时间）':'任务创建日期（北京时间）'],['筛选',JSON.stringify(filters)],['说明','无SLA不入按期分母；未核实不计算精确周期；办理周期不是净工时；并行等待按每来源区间并集；任务时效按逐单业务观察时刻，生成时间为真实时间；场景业务时间不与真实登记时间计算登记延迟']]},{name:'节点明细',rows},{name:'办理及更正事实',rows:[['任务','事件','操作者','发生','登记','质量','更正原事件','原因'],...result.rows.flatMap(r=>r.events.map(e=>[r.taskId,e.kind,e.actorName??e.actorId,e.at??'',e.recordedAt,e.quality,e.correctsId??'',String(e.payload.reason??e.payload.note??'')]))]},{name:'主办接续及代理',rows:[['任务','类型','时间','原主办','接续/代理','记录人/结束'],...result.rows.flatMap(r=>[...r.assignmentHistory.map(a=>[r.taskId,'改派',a.at,a.beforeName??'',a.afterName??'',a.actorName]),...r.delegations.map(d=>[r.taskId,'代理',d.from,'',d.name,d.revokedAt??d.expiresAt])])]}]);
  await this.database.query("INSERT INTO audit_events(id,request_id,actor_id,action,entity_type,entity_id,after_state) VALUES($1::uuid,$2,$3,'digital.analysis.exported','digital_analysis',$1::text,$4)",[randomUUID(),actor.requestId,actor.actorId,JSON.stringify({filters,ruleVersion:result.ruleVersion,rowCount:result.total})]);
  return content;
 }
 async record(actor:TrustedActorContext,note:DigitalAnalysisNote,key:string){
  if(note.filters.view==='production')throw new ApplicationError('VALIDATION_ERROR','当前生产查询结果只读；原任务分析记录请在原任务分析范围办理',400);
  if(!isDigitalLeader(actor)&&!isDigitalTechnicalManager(actor))digitalForbidden();
  if(!/^[A-Za-z0-9._:-]{1,128}$/.test(key))throw new ApplicationError('VALIDATION_ERROR','缺少操作标识',400);
  const snapshot=await this.read(db=>this.snapshot(db,actor,note.filters));
  if(note.taskIds.some(id=>!snapshot.rows.some(row=>row.taskId===id)))throw new ApplicationError('NOT_FOUND','所引用任务不在当前授权筛选范围',404);
  const db=await this.database.connect();try{await db.query('BEGIN');await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`digital-analysis:${actor.actorId}:${key}`]);
   const hash=createHash('sha256').update(JSON.stringify(note)).digest('hex');
   const prior=(await db.query("SELECT payload_hash,response FROM digital_production_commands WHERE actor_id=$1 AND command='analysis-record' AND key=$2",[actor.actorId,key])).rows[0];
   if(prior){if(prior.payload_hash!==hash)throw new ApplicationError('CONFLICT','操作标识已用于不同记录',409);await db.query('COMMIT');return prior.response;}
   const id=randomUUID();await db.query("INSERT INTO audit_events(id,request_id,actor_id,action,entity_type,entity_id,after_state) VALUES($1::uuid,$2,$3,'digital.analysis.recorded','digital_analysis',$1::text,$4)",[id,actor.requestId,actor.actorId,JSON.stringify({...note,ruleVersion:snapshot.ruleVersion,asOf:snapshot.asOf})]);
   await db.query("INSERT INTO digital_production_commands(actor_id,command,key,payload_hash,response) VALUES($1,'analysis-record',$2,$3,$4)",[actor.actorId,key,hash,JSON.stringify({id})]);await db.query('COMMIT');return {id};
  }catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
 }
}
