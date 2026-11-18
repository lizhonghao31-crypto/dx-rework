import { ownedPostgresSchema, createOwnedPostgresSchema, dropOwnedPostgresSchema } from "../helpers/owned-postgres-schema.js";
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import type {PoolClient} from 'pg';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {readQuoteAnalysis,QUOTE_ANALYSIS_SQL} from '../../apps/api/src/sourcing/sourcing-analysis.js';
import {readWorkflowAnalysis} from '../../apps/api/src/reporting/workflow-analysis.js';
import {readOperationDiagnostics,recordOperationDiagnostic} from '../../apps/api/src/platform/operation-diagnostics.js';
const url=process.env.TEST_DATABASE_URL??process.env.DATABASE_URL;
(url?describe:describe.skip)('work analysis PostgreSQL facts',()=>{
 const schema=ownedPostgresSchema("sourcing"),admin=new pg.Pool({connectionString:url!}),db=new pg.Pool({connectionString:url!,options:`-c search_path=${schema}`});
 const ids=Array.from({length:17},()=>randomUUID()),rw=randomUUID(),missing=randomUUID(),q1=randomUUID(),q2=randomUUID(),decision=randomUUID(),transfer=randomUUID(),approved=randomUUID(),transferApproved=randomUUID();
 beforeAll(async()=>{
  await createOwnedPostgresSchema(admin,schema);await db.query("SET TIME ZONE 'UTC'");
  await db.query(`CREATE TABLE sourcing_cases(sourcing_case_id uuid PRIMARY KEY,erp_order_no text,style_no text,created_at timestamptz,deleted_at timestamptz);
   CREATE TABLE sourcing_case_lines(sourcing_case_id uuid,position int,style_no text,color text,quantity int,external_unit_price numeric(18,4),PRIMARY KEY(sourcing_case_id,position));
   CREATE VIEW current_sourcing_case_lines AS SELECT * FROM sourcing_case_lines;
   CREATE VIEW sourcing_style_aliases AS SELECT sourcing_case_id,position,style_no FROM sourcing_case_lines;
   CREATE TABLE sourcing_ie_quotes(sourcing_ie_quote_id uuid PRIMARY KEY,sourcing_case_id uuid,quote_version int,quoted_at timestamptz);
   CREATE TABLE sourcing_ie_quote_lines(sourcing_ie_quote_id uuid,sourcing_case_id uuid,position int,quantity int,unit_price numeric(18,4));
   CREATE TABLE sourcing_decisions(sourcing_decision_id uuid PRIMARY KEY,source_type text);
   CREATE TABLE sourcing_approval_snapshots(sourcing_approval_snapshot_id uuid PRIMARY KEY,sourcing_case_id uuid,sourcing_decision_id uuid,decision_version int,approved_at timestamptz);
   CREATE TABLE sourcing_approval_snapshot_lines(sourcing_approval_snapshot_id uuid,position int,style_no text,color text,quantity int,unit_price numeric(18,4));
   CREATE TABLE sourcing_case_transitions(sourcing_transition_id uuid PRIMARY KEY,sourcing_case_id uuid,sequence int,from_status text,to_status text,business_action text,transitioned_at timestamptz);
   CREATE VIEW current_sourcing_cases AS SELECT c.*,COALESCE(t.to_status,'pending_ie_quote') status FROM sourcing_cases c LEFT JOIN LATERAL(SELECT to_status FROM sourcing_case_transitions WHERE sourcing_case_id=c.sourcing_case_id ORDER BY sequence DESC LIMIT 1)t ON true WHERE c.deleted_at IS NULL;
   CREATE TABLE rework_orders(rework_order_id uuid PRIMARY KEY,rework_no text,style_no text,status text,created_at timestamptz);
   CREATE TABLE operation_events(event_id uuid PRIMARY KEY,entity_id text,entity_type text,action text,before_state jsonb,after_state jsonb,created_at timestamptz);
   CREATE FUNCTION reject_operation_event_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'immutable'; END $$;`);
  await db.query(`ALTER TABLE rework_orders ADD COLUMN order_no text,ADD COLUMN merchandiser_user_id uuid,ADD COLUMN processing_factory_supplier_id uuid,ADD COLUMN processing_factory_supplier_version int;
   ALTER TABLE operation_events ADD COLUMN actor_id uuid,ADD COLUMN reason text;
   CREATE TABLE app_users(id uuid,display_name text);
   CREATE TABLE rework_todos(recipient_user_id uuid,status text,todo_type text,route_descriptor jsonb,entity_type text,entity_id text);
   CREATE TABLE rework_work_tasks(work_task_id uuid,rework_order_id uuid,configuration_item_id uuid,status text);
   CREATE TABLE rework_process_configuration_items(configuration_item_id uuid,process_name text,position int);
   CREATE TABLE rework_work_task_members(work_task_id uuid,display_name_snapshot text);
   CREATE TABLE rework_work_reports(work_report_id uuid,work_task_id uuid,actual_quantity numeric,completed_at timestamptz,submitted_by uuid);
   CREATE TABLE rework_work_report_rejections(work_report_id uuid);
   CREATE TABLE supplier_catalog_versions(supplier_id uuid,version int,supplier_name text);
   CREATE TABLE rework_order_supply_context(rework_order_id uuid,washing_supplier_id uuid,washing_supplier_version int,embroidery_supplier_id uuid,embroidery_supplier_version int,fabric_supplier_id uuid,fabric_supplier_version int);
   CREATE TABLE rework_external_responsibility_cases(rework_order_id uuid,supplier_name_snapshot text);`);
  await db.query(await readFile(new URL('../../apps/api/migrations/0161_work_operation_diagnostics.sql',import.meta.url),'utf8'));
  await db.query(await readFile(new URL('../../apps/api/migrations/0204_operation_diagnostic_latency.sql',import.meta.url),'utf8'));
  for(let i=0;i<ids.length;i++){
   await db.query("INSERT INTO sourcing_cases VALUES($1,$2,'STYLE','2026-09-01',$3)",[ids[i],`ORDER-${String(i).padStart(2,'0')}`,i===16?'2026-09-06':null]);
   await db.query("INSERT INTO sourcing_case_lines VALUES($1,1,'STYLE','蓝',100,$2)",[ids[i],i===16?null:'1.2345']);
  }
  await db.query("INSERT INTO sourcing_ie_quotes VALUES($1,$3,1,'2026-09-02'),($2,$3,2,'2026-09-03')",[q1,q2,ids[0]]);
  await db.query("INSERT INTO sourcing_ie_quote_lines VALUES($1,$3,1,100,1.2000),($2,$3,1,100,1.1800)",[q1,q2,ids[0]]);
  await db.query("INSERT INTO sourcing_decisions VALUES($1,'initial'),($2,'factory_change')",[decision,transfer]);
  await db.query("INSERT INTO sourcing_approval_snapshots VALUES($1,$3,$4,1,'2026-09-04'),($2,$3,$5,2,'2026-09-05')",[approved,transferApproved,ids[0],decision,transfer]);
  await db.query("INSERT INTO sourcing_approval_snapshot_lines VALUES($1,1,'STYLE','蓝',90,1.1678),($2,1,'TRANSFER','红',200,9.9999)",[approved,transferApproved]);
  const transitions=[[null,'pending_ie_quote','created'],['pending_ie_quote','pending_management_decision','ie_price_quoted'],['pending_management_decision','pending_owner_approval','management_decision_recorded'],['pending_owner_approval','pending_management_decision','owner_rejected'],['pending_management_decision','pending_owner_approval','management_decision_recorded'],['pending_owner_approval','pending_finance_reconciliation','owner_approved']];
  for(let i=0;i<transitions.length;i++)await db.query('INSERT INTO sourcing_case_transitions VALUES($1,$2,$3,$4,$5,$6,$7)',[randomUUID(),ids[0],i+1,...transitions[i]!,`2026-09-0${i+1}T00:00:00Z`]);
  await db.query("INSERT INTO rework_orders(rework_order_id,rework_no,style_no,status,created_at) VALUES($1,'RW-1','STYLE','pending_ie_review','2026-09-01'),($2,'RW-MISSING','STYLE','in_progress','2026-09-01')",[rw,missing]);
  for(const [index,from,to] of [[0,null,'pending_ie_review'],[1,'pending_ie_review','pending_task_assignment'],[2,'pending_task_assignment','pending_ie_review']] as const)await db.query("INSERT INTO operation_events(event_id,entity_id,entity_type,action,before_state,after_state,created_at) VALUES($1,$2,'rework_order','rework.process.review',$3,$4,$5)",[randomUUID(),rw,JSON.stringify({status:from}),JSON.stringify({status:to}),`2026-09-0${index+1}T00:00:00Z`]);
  await db.query("INSERT INTO sourcing_case_transitions VALUES($1,$2,7,'pending_finance_reconciliation','pending_finance_reconciliation','finance_matched','2026-09-07')",[randomUUID(),ids[0]]);
  await db.query("INSERT INTO operation_events(event_id,entity_id,entity_type,action,before_state,after_state,created_at) VALUES($1,$2,'sourcing_case','sourcing.attachments.supplement','{}','{}','2026-09-07')",[randomUUID(),ids[0]]);
  await db.query("INSERT INTO operation_events(event_id,entity_id,entity_type,action,before_state,after_state,created_at) VALUES($1,'private-person','supplier','master_data.supplier.revise',$2,$3,'2026-09-07')",[randomUUID(),JSON.stringify({active:true,bankAccount:'old-secret',cookie:'secret'}),JSON.stringify({active:false,bankAccount:'new-secret',cookie:'changed-secret'})]);
  for(const [index,status] of [200,400,403,503].entries())await recordOperationDiagnostic(db,{operation:'sample_create',status,code:status===400?'VALIDATION_ERROR':'arbitrary-secret',replayed:true,durationMs:10.5+index});
 });
 afterAll(async()=>{await db.end();await dropOwnedPostgresSchema(admin,schema);await admin.end();});
 it('preserves all price versions, quantities and four-decimal history; excludes transfer approvals',async()=>{
  const result=await readQuoteAnalysis(db,{q:'ORDER-00'}),item=result.items[0]!;
  expect(item.initial.lines[0]).toMatchObject({quantity:'100',unitPrice:'1.2345'});expect(item.ie.map(s=>s.version)).toEqual([1,2]);expect(item.approved).toHaveLength(1);expect(item.approved[0]?.lines[0]).toMatchObject({quantity:'90',unitPrice:'1.1678'});expect(JSON.stringify(result)).not.toMatch(/TRANSFER|9.9999|bank/);
 });
 it('aggregates before 15-row pages and preserves archived missing initial facts',async()=>{
  const one=await readQuoteAnalysis(db,{}),two=await readQuoteAnalysis(db,{page:2});expect(one.total).toBe(17);expect(two.total).toBe(17);expect(one.items).toHaveLength(15);expect(two.items).toHaveLength(2);expect(one.missingInitialCount).toBe(1);expect([...one.items,...two.items].find(i=>i.archived)?.initial.lines[0]?.unitPrice).toBeNull();
 });
 it('limits detailed quote work in PostgreSQL while retaining full-set counts on empty pages',async()=>{
  const result=await readQuoteAnalysis(db,{page:99});expect(result.total).toBe(17);expect(result.missingInitialCount).toBe(1);expect(result.items).toHaveLength(0);
  const plan=await db.query(`EXPLAIN (ANALYZE,FORMAT JSON) ${QUOTE_ANALYSIS_SQL}`,['',null,null,15,0]);
  const root=plan.rows[0]!['QUERY PLAN'][0].Plan;const nodes:Record<string,unknown>[]=[];const visit=(node:Record<string,unknown>)=>{nodes.push(node);for(const child of (node.Plans??[]) as Record<string,unknown>[])visit(child);};visit(root);
  expect(nodes.find(n=>n['Node Type']==='CTE Scan'&&n['CTE Name']==='selected')?.['Actual Rows']).toBe(15);
 });
 it('keeps finance independent and owner return history with exact entry/exit records',async()=>{
  const result=await readWorkflowAnalysis(db,{group:'finance'},true);expect(result.total).toBe(1);const item=result.items[0]!;expect(item.independentFinance).toBe(true);expect(item.history.find(h=>h.action==='sourcing.attachments.supplement')).toMatchObject({changesNode:false,to:null,leftAt:null});expect(item.enteredAt).toBe('2026-09-06T00:00:00.000Z');expect(item.history.find(h=>h.action==='owner_rejected')).toMatchObject({enteredAt:'2026-09-04T00:00:00.000Z',leftAt:'2026-09-05T00:00:00.000Z'});
  expect((await readWorkflowAnalysis(db,{group:'waiting'},true)).items.every(i=>!i.independentFinance)).toBe(true);
  await db.query("INSERT INTO sourcing_case_transitions VALUES($1,$2,8,'pending_finance_reconciliation','pending_factory_change_verification','factory_change_requested','2026-09-07T10:00:00Z'),($3,$2,9,'pending_factory_change_verification','pending_finance_reconciliation','factory_change_rejected','2026-09-08T10:00:00Z')",[randomUUID(),ids[0],randomUUID()]);
  const after=(await readWorkflowAnalysis(db,{group:'finance'},true)).items[0]!;expect(after.enteredAt).toBe(item.enteredAt);expect(after.history.find(h=>h.action==='owner_approved')?.leftAt).toBeNull();expect(after.history.some(h=>h.action.startsWith('factory_change'))).toBe(false);
 });
 it('does not expose sourcing without its separate permission and does not fabricate missing entry',async()=>{
  const result=await readWorkflowAnalysis(db,{},false);expect(result.total).toBe(2);expect(result.items.every(i=>i.kind==='rework')).toBe(true);expect(result.missingEntryCount).toBe(1);expect(result.items.find(i=>i.id===missing)?.enteredAt).toBeNull();expect(result.items.find(i=>i.id===rw)?.enteredAt).toBe('2026-09-03T00:00:00.000Z');expect(result.items.find(i=>i.id===rw)?.history).toHaveLength(3);
 });
 it('uses real actors and task members, searches related facts and does not reset entry on ordinary work reports',async()=>{
  const order=randomUUID(),actor=randomUUID(),handler=randomUUID(),supplier=randomUUID(),task=randomUUID(),process=randomUUID(),report=randomUUID();
  await db.query("INSERT INTO app_users VALUES($1,'提交人甲'),($2,'处理人乙')",[actor,handler]);
  await db.query("INSERT INTO supplier_catalog_versions VALUES($1,1,'真实测试供应商')",[supplier]);
  await db.query("INSERT INTO rework_orders(rework_order_id,rework_no,style_no,status,created_at,order_no,merchandiser_user_id,processing_factory_supplier_id,processing_factory_supplier_version) VALUES($1,'RW-ACTOR','STYLE-ACTOR','in_progress','2026-09-01','ORIGINAL-123',$2,$3,1)",[order,actor,supplier]);
  await db.query("INSERT INTO operation_events(event_id,entity_id,entity_type,action,before_state,after_state,created_at,actor_id) VALUES($1,$2,'rework_order','rework.work_assignment.confirm','{\"status\":\"pending_task_assignment\"}','{\"status\":\"in_progress\"}','2026-09-02',$3),($4,$2,'rework_order','rework.work_report.submit','{\"submittedQuantity\":0}','{\"status\":\"in_progress\"}','2026-09-03',$3)",[randomUUID(),order,actor,randomUUID()]);
  await db.query("INSERT INTO rework_todos VALUES($1,'pending','business_action',$2,'rework_order',$3)",[handler,JSON.stringify({reworkOrderId:order}),order]);
  await db.query("INSERT INTO rework_process_configuration_items VALUES($1,'车缝',1)",[process]);
  await db.query("INSERT INTO rework_work_tasks VALUES($1,$2,$3,'active')",[task,order,process]);
  await db.query("INSERT INTO rework_work_task_members VALUES($1,'王工'),($1,'李工')",[task]);
  await db.query("INSERT INTO rework_work_reports VALUES($1,$2,20,'2026-09-03',$3)",[report,task,actor]);
  const result=await readWorkflowAnalysis(db,{group:'rework',q:'RW-ACTOR'},false),item=result.items[0]!;
  expect(item).toMatchObject({enteredAt:'2026-09-02T00:00:00.000Z',submitterName:'提交人甲',handlers:['处理人乙']});
  expect(item.history.find(h=>h.action==='rework.work_report.submit')?.changesNode).toBe(false);
  expect(item.execution[0]).toMatchObject({processName:'车缝',people:expect.arrayContaining(['王工','李工']),reports:[expect.objectContaining({quantity:'20',actorName:'提交人甲',rejected:false})]});
  for(const q of ['ORIGINAL-123','王工','提交人甲','真实测试供应商'])expect((await readWorkflowAnalysis(db,{group:'rework',q},false)).items.some(r=>r.id===order)).toBe(true);
  await db.query("INSERT INTO operation_events(event_id,entity_id,entity_type,action,before_state,after_state,created_at,actor_id,reason) VALUES($1,$2,'rework_order','rework.work_report.reject','{\"status\":\"pending_order_review\"}','{\"status\":\"in_progress\"}','2026-09-04',$3,'重新核对数量')",[randomUUID(),order,handler]);
  const returned=(await readWorkflowAnalysis(db,{group:'rework',q:'RW-ACTOR',roundtrip:'yes'},false)).items[0]!;
  expect(returned.roundtripCount).toBe(1);expect(returned.history.at(-1)).toMatchObject({actorName:'处理人乙',reason:'重新核对数量',returned:true});
  const connect=db.connect.bind(db) as (...args:unknown[])=>unknown;
  const queries:Array<{sql:string;ids:string[]|null}>=[];
  const spy=vi.spyOn(db,'connect').mockImplementation(((...args:unknown[])=>{
   const opened=connect(...args);if(args.length)return opened;
   return (opened as Promise<PoolClient>).then(client=>new Proxy(client,{get(target,key){
    if(key==='query')return (...query:unknown[])=>{
     const [sql,params]=query;
     if(typeof sql==='string'&&sql.startsWith('WITH snapshots AS'))queries.push({sql,ids:(params as Array<string[]|null>)[4]??null});
     return Reflect.apply(target.query,target,query);
    };
    const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
   }}));
  }) as typeof db.connect);
  try{
   const filters={group:'rework',q:'RW-ACTOR',snapshot:'period_end',from:'2026-09-01',to:'2026-09-05'};
   const historical=await readWorkflowAnalysis(db,filters,false);
   expect(historical.items[0]).toMatchObject({id:order,submitterName:null,handlers:[],execution:[]});
   expect(historical.items[0]!.history.at(-1)).toMatchObject({actorName:'处理人乙',reason:'重新核对数量',returned:true});
   expect(queries.map(query=>query.ids)).toEqual([null,[order]]);
   expect(queries[0]!.sql).not.toContain("'actorName',u.display_name");
   expect(queries.every(query=>!query.sql.includes("'processName',i.process_name"))).toBe(true);
   const empty=await readWorkflowAnalysis(db,{...filters,page:2},false);
   expect(empty.items).toEqual([]);expect(empty.total).toBe(historical.total);expect(empty.nodeMetrics).toEqual(historical.nodeMetrics);
   expect(queries.map(query=>query.ids)).toEqual([null,[order],null]);
  }finally{spy.mockRestore();}
 });
 it('aggregates safe outcomes and only whitelisted changed field names, without sensitive values',async()=>{
  const result=await readOperationDiagnostics(db,{});expect(result.recordCount).toBe('4');expect(result.groups).toHaveLength(4);expect(result.groups.find(g=>g.outcome==='success')?.replayedCount).toBe('1');expect(result.groups.filter(g=>g.outcome!=='success').every(g=>g.replayedCount==='0')).toBe(true);expect(result.revisions).toEqual([{action:'master_data.supplier.revise',field:'active',count:'1'}]);expect(JSON.stringify(result)).not.toMatch(/private-person|secret|bankAccount|cookie/);
 });
 it('supports outcome/date filtering while leaving absent historical failures explicitly empty',async()=>{
  const permission=await readOperationDiagnostics(db,{group:'permission'});expect(permission.recordCount).toBe('1');expect(permission.groups[0]).toMatchObject({timingSampleCount:'1',averageDurationMs:12.5,maxDurationMs:12.5});const old=await readOperationDiagnostics(db,{to:'2020-01-01'});expect(old.groups).toHaveLength(0);expect(old.recordingSince).not.toBeNull();
 });
 it('rejects mutation and unsafe fields at the new database boundary',async()=>{
  await expect(db.query("UPDATE work_operation_diagnostics SET error_code='OK'")).rejects.toThrow('immutable');await expect(db.query('DELETE FROM work_operation_diagnostics')).rejects.toThrow('immutable');await expect(db.query('TRUNCATE work_operation_diagnostics')).rejects.toThrow('immutable');
  await expect(db.query("INSERT INTO work_operation_diagnostics(diagnostic_id,operation,http_status,outcome,error_code) VALUES($1,'secret',400,'validation','secret')",[randomUUID()])).rejects.toThrow();
 });
 it('has indexed diagnostic time and entity history paths with executable query plans',async()=>{
  const indexes=await db.query<{indexdef:string}>("SELECT indexdef FROM pg_indexes WHERE schemaname=$1 AND indexname IN ('work_operation_diagnostics_time_idx','work_analysis_events_history_idx')",[schema]);expect(indexes.rows).toHaveLength(2);
  const plan=await db.query('EXPLAIN (ANALYZE,FORMAT JSON) SELECT operation,count(*) FROM work_operation_diagnostics WHERE recorded_at>=CURRENT_TIMESTAMP-interval \'1 day\' GROUP BY operation');expect(JSON.stringify(plan.rows)).toContain('Execution Time');
 });
});

