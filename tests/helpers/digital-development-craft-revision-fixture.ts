import {randomUUID} from "node:crypto";
import type {Pool} from "pg";
import {expect} from "vitest";
import type {TrustedActorContext} from "../../apps/api/src/tools/repositories.js";
import type {DevelopmentExecutionService} from "../../apps/api/src/production-platform/development-execution-service.js";
import {DevelopmentRoundService} from "../../apps/api/src/production-platform/development-round-service.js";
import {DigitalDevelopmentService} from "../../apps/api/src/production-platform/development-service.js";

/** A real garment revision after a first craft route automatically bypassed the clerk transfer. */
export async function exerciseGarmentCraftRevision(db:Pool,execution:DevelopmentExecutionService,root:TrustedActorContext,sourceId:string,workerId:string,nativeRoundId:string,outsider:TrustedActorContext){
 const forms=new DigitalDevelopmentService(db,true),rounds=new DevelopmentRoundService(db,true),original=await forms.read(root,sourceId);
 const wages=async()=>(await db.query('SELECT count(*)::int n FROM pattern_room_segments WHERE round_id=$1 AND wage_eligible_at IS NOT NULL',[nativeRoundId])).rows[0].n;
 const before=await wages();
 const revision={basedOnRound:1,document:original.document!,origin:'客户新增要求' as const,customerComment:'TEST仅重做印花，沿用已完成车板',internalProblem:'',explanation:'TEST按原路线继承事实',categories:['工艺' as const],affectedNodes:['工艺' as const],outputKind:'整件样板' as const};
 const saved=await rounds.save(root,sourceId,{expectedDraftVersion:0,revision},randomUUID());
 await rounds.publish(root,sourceId,{expectedDraftVersion:saved.draftVersion,basedOnRound:1},randomUUID());
 const persisted=(await db.query('SELECT route_nodes,inherited FROM digital_development_rounds WHERE source_id=$1 AND round_number=2',[sourceId])).rows[0];
 expect(persisted.route_nodes).toEqual(['development_craft_dispatch','development_printing','development_craft_confirmation','development_sewing_transfer','development_tail_check','development_confirmation','development_shipping']);
 expect(persisted.inherited.development_sewing).toMatchObject({roundNumber:1});
 const tasks=async()=>(await execution.read(root,sourceId)).tasks.filter(task=>task.routeVersion===2);
 const task=async(kind:string)=>{const value=(await tasks()).find(item=>item.taskKind===kind);expect(value,kind).toBeDefined();return value!;};
 const input=(taskId:string,kind:string)=>({taskId,result:'通过' as const,note:'TEST按本轮持久化路线办理',craftExecution:kind==='development_craft_dispatch'?'内部' as const:null,nextAssigneeId:kind==='development_craft_dispatch'?workerId:null,sentDate:kind==='development_shipping'?'2026-09-30':null,trackingNo:kind==='development_shipping'?'TEST-CRAFT-REVISION':null});
 for(const kind of ['development_craft_dispatch','development_printing'])await execution.route(root,sourceId,input((await task(kind)).taskId,kind),randomUUID());
 const confirmation=await task('development_craft_confirmation'),body=input(confirmation.taskId,confirmation.taskKind),key=randomUUID();
 await expect(execution.route(outsider,sourceId,body,randomUUID())).rejects.toMatchObject({statusCode:404});
 await Promise.all([execution.route(root,sourceId,body,key),execution.route(root,sourceId,body,key)]);
 const current=await tasks();
 expect(current.every(item=>persisted.route_nodes.includes(item.taskKind))).toBe(true);
 expect(current.some(item=>item.taskKind==='development_sewing')).toBe(false);
 expect(current.filter(item=>item.taskKind==='development_sewing_transfer')).toHaveLength(1);
 expect(current.find(item=>item.taskKind==='development_sewing_transfer')).toMatchObject({state:'ready'});
 expect(current.some(item=>item.taskKind==='development_tail_check')).toBe(false);
 for(const kind of ['development_sewing_transfer','development_tail_check','development_confirmation','development_shipping']){
  const currentTask=await task(kind);
  if(kind==='development_tail_check')expect(currentTask).toMatchObject({state:'ready',slaHours:4});
  await execution.route(root,sourceId,input(currentTask.taskId,kind),randomUUID());
 }
 expect((await tasks()).every(item=>persisted.route_nodes.includes(item.taskKind)&&item.state==='completed')).toBe(true);
 expect((await tasks()).filter(item=>item.taskKind==='development_tail_check')).toHaveLength(1);
 expect(await wages()).toBe(before);
 expect((await forms.read(root,sourceId,undefined,1)).document).toEqual(original.document);
}
