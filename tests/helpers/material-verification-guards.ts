import {projectDevelopmentNotices} from "../../apps/api/src/production-platform/development-notifications.js";
import {randomUUID} from "node:crypto";
import {expect} from "vitest";
import type {Pool} from "pg";
import type {TrustedActorContext} from "../../apps/api/src/tools/repositories.js";
import type {DevelopmentExecutionService} from "../../apps/api/src/production-platform/development-execution-service.js";
import {fabricDecisionTodos} from "../../apps/api/src/production-platform/development-fabric-cases.js";
import {materialReadiness} from "../../apps/api/src/production-platform/development-material-readiness.js";
export async function exerciseMaterialVerification(db:Pool,execution:DevelopmentExecutionService,clerk:TrustedActorContext,root:TrustedActorContext,sourceId:string,taskId:string,items:Array<{materialId:string;physical:boolean;quantity:boolean;color:boolean;specification:boolean}>,guards:boolean){
 const initial=(await execution.read(clerk,sourceId)).materialVerification!;
 expect(initial.entries.every(row=>row.usage==="pending")).toBe(true);
 const input={taskId,expectedDocumentVersion:initial.documentVersion,expectedVersion:0,note:"TEST已与设计师核实使用材料",result:"通过",entries:initial.entries.map(row=>({materialId:row.materialId,usage:"use" as const,physical:false,quantity:false,color:false,specification:false,note:"",confirmedWith:"",...items.find(m=>m.materialId===row.materialId)}))};
 const check={taskId,result:"通过" as const,note:"TEST拉链缺料按原例外跟进",items};
 if(guards){
  await expect(execution.check(clerk,sourceId,check,randomUUID())).rejects.toThrow("先保存");
  await expect(execution.saveMaterials(clerk,sourceId,{...input,entries:input.entries.map((row,i)=>i?row:{...row,usage:"unused",note:"",confirmedWith:""})},randomUUID())).rejects.toThrow("设计师");
  expect((await execution.read(clerk,sourceId)).materialVerification!.version).toBe(0);
 }
 if(guards){
  await expect(execution.saveMaterials({...clerk,actorId:root.actorId,actorRoles:['sample_designer']},sourceId,input,randomUUID())).rejects.toThrow();
  await db.query("CREATE FUNCTION test_material_rollback() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'TEST atomic rollback'; END $$");
  await db.query("CREATE TRIGGER test_material_rollback BEFORE INSERT ON audit_events FOR EACH ROW WHEN (NEW.action='development_material_verification') EXECUTE FUNCTION test_material_rollback()");
  try{await expect(execution.saveMaterials(clerk,sourceId,input,randomUUID())).rejects.toThrow('TEST atomic rollback');}
  finally{await db.query('DROP TRIGGER test_material_rollback ON audit_events');await db.query('DROP FUNCTION test_material_rollback()');}
  expect((await execution.read(clerk,sourceId)).materialVerification!.version).toBe(0);
 }
 const key=randomUUID();
 await execution.saveMaterials(clerk,sourceId,input,key);
 await execution.saveMaterials(clerk,sourceId,input,key);
 let saved=(await execution.read(clerk,sourceId)).materialVerification!;
 expect(saved.version).toBe(1);expect(saved.entries.every(row=>row.changedBy&&row.changedAt)).toBe(true);
 expect((await materialReadiness(db,sourceId,1)).earlyReady).toBe(false); // Draft does not certify checks.
 expect((await materialReadiness(db,sourceId,1)).materials.every(row=>row.usage===undefined)).toBe(true);
 if(guards){
  await expect(execution.saveMaterials(clerk,sourceId,{...input,expectedVersion:0},randomUUID())).rejects.toThrow("已更新");
  const results=await Promise.allSettled([1,2].map(()=>execution.saveMaterials(clerk,sourceId,{...input,expectedVersion:1},randomUUID())));
  expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);
  saved=(await execution.read(clerk,sourceId)).materialVerification!;
  const fileId=randomUUID();await db.query("INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,status,ready_at) VALUES($1,$2,'TEST-quality.pdf','application/pdf',100,$3,$4,'ready',CURRENT_TIMESTAMP)",[fileId,`test-quality/${fileId}`,'d'.repeat(64),root.actorId]);
  await execution.recordUploadPurpose(root,sourceId,fileId,"面料报告");
  const report=await execution.report(root,sourceId,{recommendation:"建议停用",note:"TEST质量风险，不能由到料解除",attachmentIds:[fileId],materialIds:[items[0]!.materialId]},randomUUID()) as {reportId:string};
  const directorId=(await db.query("SELECT user_id FROM user_role_assignments WHERE role_code='production_management' AND revoked_at IS NULL LIMIT 1")).rows[0].user_id;
  const director={...clerk,actorId:directorId,actorRoles:['production_management']};
  const noticeClient=await db.connect();try{await projectDevelopmentNotices(noticeClient,[director,clerk]);await projectDevelopmentNotices(noticeClient,[director,clerk]);}finally{noticeClient.release();}
  expect((await db.query("SELECT count(*)::int n FROM digital_production_notification_events e JOIN digital_production_notification_receipts r USING(event_id) WHERE e.source_key=$1 AND r.recipient_id=$2",[`fabric-decision:${report.reportId}`,directorId])).rows[0].n).toBe(1);
  expect((await fabricDecisionTodos(db,director)).filter(t=>t.todoId===report.reportId)).toHaveLength(1);
  expect((await fabricDecisionTodos(db,root)).filter(t=>t.todoId===report.reportId)).toHaveLength(1);
  expect((await fabricDecisionTodos(db,clerk)).filter(t=>t.todoId===report.reportId)).toHaveLength(0);
  await expect(execution.check(clerk,sourceId,{...check,expectedVerificationVersion:saved.version},randomUUID())).rejects.toThrow("供应链总监");
  expect((await materialReadiness(db,sourceId,1)).materials.every(row=>row.usage===undefined)).toBe(true);
  await expect(execution.decideFabric(clerk,sourceId,{reportId:report.reportId,expectedDecisionId:null,decision:"允许使用",note:"TEST越权"},randomUUID())).rejects.toMatchObject({statusCode:403});
  const stopped=await execution.decideFabric(root,sourceId,{reportId:report.reportId,expectedDecisionId:null,decision:"停止使用",note:"TEST停止并保留质量事实"},randomUUID()) as {factId:string};
  expect((await fabricDecisionTodos(db,root)).filter(t=>t.todoId===report.reportId)).toHaveLength(0);
  await expect(execution.check(clerk,sourceId,{...check,expectedVerificationVersion:saved.version},randomUUID())).rejects.toThrow("供应链总监");
  await expect(execution.decideFabric(root,sourceId,{reportId:report.reportId,expectedDecisionId:null,decision:"允许使用",note:"TEST旧页面"},randomUUID())).rejects.toThrow("新的决定");
  await execution.decideFabric(director,sourceId,{reportId:report.reportId,expectedDecisionId:stopped.factId,decision:"允许使用",note:"TEST明确复核允许"},randomUUID());
 }
 if(guards){
  const missingEntries=input.entries.map((row,i)=>i?row:{...row,color:false});
  await execution.saveMaterials(clerk,sourceId,{...input,expectedVersion:saved.version,entries:missingEntries,note:'TEST颜色待复核',result:'缺项退回'},randomUUID());
  saved=(await execution.read(clerk,sourceId)).materialVerification!;
  await execution.check(clerk,sourceId,{...check,expectedVerificationVersion:saved.version,result:'缺项退回',note:'TEST颜色待复核',items:items.map((row,i)=>i?row:{...row,color:false})},randomUUID());
  expect((await materialReadiness(db,sourceId,1)).materials.every(row=>row.usage==='use')).toBe(true);
  const supply=(await execution.read(root,sourceId)).tasks.find(t=>t.taskKind==='development_material_supply'&&t.state==='ready')!;
  const recheck=await execution.resubmit(root,sourceId,supply.taskId,randomUUID()) as {taskId:string};
  const restored=(await execution.read(clerk,sourceId)).materialVerification!;
  expect(restored.note).toBe('TEST颜色待复核');expect(restored.entries[0]).toMatchObject({usage:'use',physical:true,quantity:true,color:false,specification:true});
  await expect(execution.check(clerk,sourceId,{...check,taskId:recheck.taskId,expectedVerificationVersion:restored.version},randomUUID())).rejects.toThrow('当前复核任务');
  await execution.saveMaterials(clerk,sourceId,{...input,taskId:recheck.taskId,expectedVersion:restored.version,entries:input.entries.map(row=>({...row,usage:'unused',confirmedWith:'TEST设计师',note:'TEST不能无主布通过'}))},randomUUID());
  saved=(await execution.read(clerk,sourceId)).materialVerification!;
  await expect(execution.check(clerk,sourceId,{...check,taskId:recheck.taskId,expectedVerificationVersion:saved.version,items:[]},randomUUID())).rejects.toThrow('不能无主料通过');
  expect((await materialReadiness(db,sourceId,1)).materials.every(row=>row.usage==='use')).toBe(true); // Rejected draft must not replace submitted use.
  await execution.saveMaterials(clerk,sourceId,{...input,taskId:recheck.taskId,expectedVersion:saved.version},randomUUID());
  saved=(await execution.read(clerk,sourceId)).materialVerification!;
  return {taskId:recheck.taskId,expectedVerificationVersion:saved.version};
 }
 return {taskId,expectedVerificationVersion:saved.version};
}
