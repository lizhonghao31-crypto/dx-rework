import {randomUUID,createHash} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import type {DigitalAnalysisFilters,DigitalAnalysisNote,DigitalAnalysisResult} from '@dx-rework/contracts/digital-production-analysis';
import type {TrustedActorContext} from '../tools/repositories.js';
import {DigitalProductionAccessPolicy,isDigitalLeader,isDigitalTechnicalManager,digitalForbidden} from './access-policy.js';
import {assertIdentityActor} from './identity-service.js';
import {assertBusinessExportAllowed} from '../access/export-authority.js';
import {ApplicationError} from '../platform/errors.js';
import {buildWorkbook,type WorkbookCell} from '../reporting/xlsx-workbook.js';
import {ANALYSIS_RULE_VERSION,taskAnalysis,summarizeAnalysis,type AnalysisTask} from './reporting-metrics.js';
import {workspaceAnalysisRows,analysisWorkspaceOverview,WORKSPACE_ANALYSIS_RULE_VERSION} from './analysis-workspace-metrics.js';
import {missingMainMaterials} from './development-route.js';
import type {DevelopmentDocument} from '@dx-rework/contracts/digital-development';
const iso=(value:Date|string|null)=>value===null?null:new Date(value).toISOString();
const range=(filters:DigitalAnalysisFilters)=>({from:new Date(`${filters.from}T00:00:00+08:00`).toISOString(),to:new Date(Date.parse(`${filters.to}T00:00:00+08:00`)+86400000).toISOString()});
export class DigitalAnalysisQuery{
 constructor(private readonly database:Pool){}
 private exportAllowed(actor:TrustedActorContext){try{assertBusinessExportAllowed(actor.actorRoles,'report:export');return isDigitalLeader(actor)&&actor.actorRoles.includes('root_superuser')||Boolean(actor.authorizationCapabilities?.includes('report:view'));}catch{return false;}}
 private async snapshot(db:PoolClient,actor:TrustedActorContext,filters:DigitalAnalysisFilters){
  assertIdentityActor(actor);const window=range(filters),asOf=new Date().toISOString();
  const candidates=(await db.query(`SELECT t.task_id AS "taskId",coalesce(a.source_id,bp.source_id,o.source_id) AS "sourceId",a.production_order_id AS "orderId",
    coalesce(o.design_style_no,s.design_style_no) AS "styleNo",coalesce(o.customer_code,s.customer_code,'') AS customer,coalesce(d.document->>'template','') AS category,
    a.required_role AS "requiredRole",a.assignee_id AS "assigneeId",u.display_name AS "assigneeName",t.node_key AS "nodeKey",p.label,t.route_version AS round,t.state,
    CASE WHEN a.source_id IS NOT NULL THEN t.route_version ELSE bp.source_round END AS "sourceRound",bp.instruction_version AS "instructionVersion",
    t.created_at AS "createdAt",t.entered_at AS "enteredAt",t.completed_at AS "completedAt",t.entered_quality AS "enteredQuality",t.completed_quality AS "completedQuality",
    ARRAY(SELECT condition_key FROM digital_production_task_conditions WHERE task_id=t.task_id AND NOT satisfied AND condition_key IN ('materials_ready','handover_received')) AS "pendingConditions",
    r.due_at AS "dueAt",r.policy_version AS "policyVersion",s.created_at AS "sourceCreatedAt",d.published_at AS "sourcePublishedAt",coalesce(d.status='published',false) AS "sourcePublished"
    FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id)
    LEFT JOIN digital_production_orders o ON o.production_order_id=a.production_order_id
    LEFT JOIN digital_bulk_preparations bp ON bp.preparation_id=t.route_instance_id AND bp.production_order_id=a.production_order_id
    LEFT JOIN digital_production_sources s ON s.source_id=coalesce(a.source_id,bp.source_id,o.source_id)
    LEFT JOIN digital_development_documents d ON d.source_id=s.source_id
    LEFT JOIN app_users u ON u.id=a.assignee_id
    JOIN LATERAL(SELECT label FROM digital_production_deadline_policies WHERE node_key=t.node_key ORDER BY version DESC LIMIT 1)p ON true
    LEFT JOIN LATERAL(SELECT due_at,policy_version FROM digital_production_deadline_revisions WHERE task_id=t.task_id ORDER BY revision_id DESC LIMIT 1)r ON true
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
  const supplySources=[...new Set(authorized.filter(row=>row.nodeKey==='development_material_supply'&&!['completed','cancelled'].includes(row.state)).map(row=>row.sourceId))];
  const supplyDocuments=supplySources.length?(await db.query('SELECT source_id,document FROM digital_development_current_documents WHERE source_id=ANY($1::uuid[])',[supplySources])).rows:[];
  const supplyEvents=supplySources.length?(await db.query('SELECT source_id,material_id AS "materialId",action FROM digital_development_material_events WHERE source_id=ANY($1::uuid[])',[supplySources])).rows:[];
  const missingSupplySources=new Set(supplyDocuments.filter(row=>missingMainMaterials(row.document as DevelopmentDocument,supplyEvents.filter(event=>event.source_id===row.source_id)).length).map(row=>row.source_id));
  const events=(await db.query(`SELECT event_id AS id,task_id AS "taskId",event_kind AS kind,occurred_at AS at,recorded_at AS "recordedAt",time_quality AS quality,actor_id AS "actorId",u.display_name AS "actorName",corrects_event_id AS "correctsId",payload
    FROM digital_production_task_events e JOIN app_users u ON u.id=e.actor_id WHERE task_id=ANY($1::uuid[]) ORDER BY recorded_at,event_id`,[ids])).rows;
  const assignments=(await db.query(`SELECT a.entity_id AS "taskId",a.created_at AS at,u.display_name AS "actorName",previous_user.display_name AS "beforeName",next_user.display_name AS "afterName"
    FROM audit_events a JOIN app_users u ON u.id=a.actor_id LEFT JOIN app_users previous_user ON previous_user.id=(a.before_state->>'assigneeId')::uuid LEFT JOIN app_users next_user ON next_user.id=(a.after_state->>'assigneeId')::uuid
    WHERE a.action='digital_task_reassigned' AND a.entity_id=ANY($1::text[]) ORDER BY a.created_at,a.id`,[ids])).rows;
  const delegations=(await db.query(`SELECT d.task_id AS "taskId",u.display_name AS name,d.created_at AS "from",d.expires_at AS "expiresAt",d.revoked_at AS "revokedAt"
    FROM digital_production_delegations d JOIN app_users u ON u.id=d.delegate_id WHERE d.task_id=ANY($1::uuid[]) AND d.purpose='execute' ORDER BY d.created_at,d.delegation_id`,[ids])).rows;
  const rows=authorized.map(row=>taskAnalysis({...row,materialSupplyPending:row.nodeKey==='development_material_supply'&&missingSupplySources.has(row.sourceId),createdAt:iso(row.createdAt)!,enteredAt:iso(row.enteredAt),completedAt:iso(row.completedAt),dueAt:iso(row.dueAt),sourceCreatedAt:iso(row.sourceCreatedAt),sourcePublishedAt:iso(row.sourcePublishedAt),events:events.filter(e=>e.taskId===row.taskId).map(e=>({...e,at:iso(e.at),recordedAt:iso(e.recordedAt)!}))} as AnalysisTask,asOf));
  const attributedRows=rows.map(row=>({...row,assignmentHistory:assignments.filter(a=>a.taskId===row.taskId).map(a=>({...a,at:iso(a.at)!})),delegations:delegations.filter(d=>d.taskId===row.taskId).map(d=>({...d,from:iso(d.from)!,expiresAt:iso(d.expiresAt)!,revokedAt:iso(d.revokedAt)}))}));
  const people=[...new Map(attributedRows.filter(row=>row.assigneeId).map(row=>[row.assigneeId!,{id:row.assigneeId!,name:row.assigneeName}])).values()];
  const scopedRows=filters.assigneeId?attributedRows.filter(row=>row.assigneeId===filters.assigneeId):attributedRows;
  // Original development reads allow source access through an already-visible source task.
  // Order-associated tasks still require the original direct source permission.
  const readableTaskSources=new Set((await db.query('SELECT DISTINCT source_id FROM digital_production_task_access WHERE task_id=ANY($1::uuid[]) AND source_id IS NOT NULL',[scopedRows.map(row=>row.taskId)])).rows.map(row=>row.source_id as string));
  const sourceIds:string[]=[];for(const sourceId of new Set(scopedRows.map(row=>row.sourceId).filter((id):id is string=>Boolean(id))))if(readableTaskSources.has(sourceId)||await policy.allowed(actor,'source',sourceId,'technical'))sourceIds.push(sourceId);
  const rawRounds=(await db.query(`SELECT source_id AS "sourceId",round_number AS round,origin,categories,affected_nodes AS "affectedNodes",customer_comment AS "customerComment",internal_problem AS "internalProblem",explanation,published_at AS "publishedAt" FROM digital_development_rounds
    WHERE source_id=ANY($1::uuid[]) AND published_at>=$2 AND published_at<$3 ORDER BY published_at,source_id,round_number`,[sourceIds,window.from,window.to])).rows;
  const rounds=rawRounds.map(row=>({...row,publishedAt:iso(row.publishedAt)!}));
  const readableSources=new Set(sourceIds);
  const selectedRows=workspaceAnalysisRows(scopedRows,rounds,filters,window.from,window.to,asOf).map(row=>({
    ...row,canReadSourceRound:row.sourceRound!=null&&readableSources.has(row.sourceId??''),
  }));
  // Shared analysis is readable only when every referenced original task remains visible.
  const rawNotes=(await db.query(`SELECT a.id,u.display_name AS author,a.created_at AS "createdAt",a.after_state AS note FROM audit_events a JOIN app_users u ON u.id=a.actor_id
    WHERE a.action='digital.analysis.recorded' AND (a.actor_id=$1 OR $2::boolean) ORDER BY a.created_at DESC,a.id DESC LIMIT 100`,[actor.actorId,isDigitalLeader(actor)||isDigitalTechnicalManager(actor)])).rows;
  const notes=[];
  for(const record of rawNotes){const note=record.note as DigitalAnalysisNote&{ruleVersion:string};let allowed=true;for(const id of note.taskIds)if(!await policy.allowed(actor,'task',id,'technical')){allowed=false;break;}if(allowed)notes.push({id:record.id,author:record.author,createdAt:iso(record.createdAt)!,...note});}
  return {ruleVersion:filters.scope?WORKSPACE_ANALYSIS_RULE_VERSION:ANALYSIS_RULE_VERSION,asOf,filters,canExport:this.exportAllowed(actor),canRecord:isDigitalLeader(actor)||isDigitalTechnicalManager(actor),page:filters.page,total:selectedRows.length,
    summary:summarizeAnalysis(selectedRows,window.from,window.to),people,overview:analysisWorkspaceOverview(scopedRows,window.from,window.to,asOf),rounds,rows:selectedRows,notes};
 }
 private async read<T>(action:(db:PoolClient)=>Promise<T>){const db=await this.database.connect();try{await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');const result=await action(db);await db.query('COMMIT');return result;}catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}}
 async list(actor:TrustedActorContext,filters:DigitalAnalysisFilters):Promise<DigitalAnalysisResult>{return this.read(async db=>{const all=await this.snapshot(db,actor,filters);return {...all,rows:all.rows.slice((filters.page-1)*50,filters.page*50)};});}
 async export(actor:TrustedActorContext,filters:DigitalAnalysisFilters){
  if(!this.exportAllowed(actor))digitalForbidden();
  const result=await this.read(db=>this.snapshot(db,actor,filters));
  const rows:WorkbookCell[][]=[['任务','来源','母单','款号','客户','品类','岗位','当前主办','开发轮次','制单版本','节点','状态','进入','完成','时间质量','期限','SLA版本','按期纳入','排除原因','办理秒数','已知等待秒数','等待缺失数'],
    ...result.rows.map(r=>[r.taskId,r.sourceId??'',r.orderId??'',r.styleNo,r.customer,r.category,r.requiredRole,r.assigneeName??'',r.sourceRound??'',r.instructionVersion??'',r.label,r.state,r.enteredAt??'',r.completedAt??'',`${r.enteredQuality}/${r.completedQuality}`,r.dueAt??'',r.policyVersion??'',r.slaIncluded?'是':'否',r.exclusion??'',r.handlingSeconds??'',r.waitingSeconds,r.unknownWaiting])];
  const content=await buildWorkbook([{name:'范围与口径',rows:[['规则版本',result.ruleVersion],['生成时间',result.asOf],['统计窗口',filters.scope==='snapshot'?'当前积压快照（不按创建日期排除）':filters.scope==='completed'?'任务原完成日期（北京时间）':filters.scope==='published'?'来源首次原发布日期（北京时间）':filters.scope==='revisions'?'复版原发布日期（北京时间）':'任务创建日期（北京时间）'],['筛选',JSON.stringify(filters)],['说明','无SLA不入按期分母；未核实不计算精确周期；办理周期不是净工时；并行等待按每来源区间并集']]},{name:'节点明细',rows},{name:'办理及更正事实',rows:[['任务','事件','操作者','发生','登记','质量','更正原事件','原因'],...result.rows.flatMap(r=>r.events.map(e=>[r.taskId,e.kind,e.actorName??e.actorId,e.at??'',e.recordedAt,e.quality,e.correctsId??'',String(e.payload.reason??e.payload.note??'')]))]},{name:'主办接续及代理',rows:[['任务','类型','时间','原主办','接续/代理','记录人/结束'],...result.rows.flatMap(r=>[...r.assignmentHistory.map(a=>[r.taskId,'改派',a.at,a.beforeName??'',a.afterName??'',a.actorName]),...r.delegations.map(d=>[r.taskId,'代理',d.from,'',d.name,d.revokedAt??d.expiresAt])])]}]);
  await this.database.query("INSERT INTO audit_events(id,request_id,actor_id,action,entity_type,entity_id,after_state) VALUES($1::uuid,$2,$3,'digital.analysis.exported','digital_analysis',$1::text,$4)",[randomUUID(),actor.requestId,actor.actorId,JSON.stringify({filters,ruleVersion:result.ruleVersion,rowCount:result.total})]);
  return content;
 }
 async record(actor:TrustedActorContext,note:DigitalAnalysisNote,key:string){
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
