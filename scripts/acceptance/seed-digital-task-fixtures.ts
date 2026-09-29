import {randomUUID} from "node:crypto";
import pg from "pg";
import {assertAcceptanceDatabaseName,assertAcceptanceDatabaseUrl} from "./database-guard.js";
import {DigitalProductionIdentityService} from "../../apps/api/src/production-platform/identity-service.js";
import {DigitalProductionTaskService} from "../../apps/api/src/production-platform/task-service.js";
import {DigitalOrderCreateSchema,DigitalSourceCreateSchema} from "@dx-rework/contracts/digital-production";
import type {TrustedActorContext} from "../../apps/api/src/tools/repositories.js";
const url=process.env.ACCEPTANCE_DATABASE_URL?.trim();
if(process.env.NODE_ENV!=="test"||process.env.ACCEPTANCE_LAB_ENABLED!=="true"||!url)throw new Error("Requires isolated Acceptance and explicit ACCEPTANCE_DATABASE_URL");
assertAcceptanceDatabaseUrl(url);
if(["TODO_RUNTIME_ENABLED","TODO_DELIVERY_ENABLED","TODO_TIMING_ENABLED"].some(key=>process.env[key]==="true"))throw new Error("Real todo runtime forbidden");
const pool=new pg.Pool({connectionString:url,max:2});
try{
  assertAcceptanceDatabaseName((await pool.query("SELECT current_database() AS name")).rows[0].name);
  const user=async(alias:string)=>{const rows=await pool.query(`SELECT i.user_id FROM identity_mappings i JOIN app_users u ON u.id=i.user_id WHERE i.provider='dingtalk' AND i.provider_user_id=$1 AND i.union_id=$2 AND i.active AND i.employed AND u.enabled`,[`uat-${alias}`,`uat-union-${alias}`]);if(rows.rows.length!==1)throw new Error(`Missing unique UAT identity ${alias}`);return rows.rows[0].user_id as string;};
  const root=await user("root"),designer=await user("sample-designer"),worker=await user("pattern-room-worker");
  const actor:TrustedActorContext={actorId:root,actorRoles:["root_superuser"],authorizationCapability:"pattern_room:orders:create",authorizationCapabilities:["pattern_room:orders:create"],requestId:"P03-A1-fixtures"};
  const identity=new DigitalProductionIdentityService(pool,true),tasks=new DigitalProductionTaskService(pool);
  const source=await identity.createSource({...actor,actorId:designer,actorRoles:["sample_designer"]},DigitalSourceCreateSchema.parse({developmentType:"头版",designStyleNo:"TEST-A1-P03-SOURCE",customerCode:"PD"}),"P03-A1-source-v1");
  const order=await identity.createOrder(actor,DigitalOrderCreateSchema.parse({customerCode:"PD",productGroup:"男装",designStyleNo:"TEST-A1-P03-ORDER",orderDate:"2026-09-29",lines:[{color:"测试黑",sizes:[{size:"M",quantity:5}]}]}),"P03-A1-order-v1");
  const c=await pool.connect();try{
    await c.query("BEGIN");await c.query("SELECT pg_advisory_xact_lock(hashtextextended('digital-production-task-lifecycle-v1',0))");
    for(const resource of [{kind:"source" as const,id:source.sourceId},{kind:"order" as const,id:order.productionOrderId}]){
      const col=resource.kind==="source"?"source_id":"production_order_id";
      if((await c.query(`SELECT 1 FROM digital_production_task_access WHERE ${col}=$1`,[resource.id])).rowCount)continue;
      const routeId=randomUUID();
      const sewing=await tasks.createWithClient(c,actor,{resource,kind:"development_sewing",routeId,routeVersion:1,occurrence:1,assigneeId:worker});
      const at=new Date(Date.now()-18*3600000).toISOString();
      await tasks.setConditionWithClient(c,actor,sewing.taskId,"materials_ready",true,at);
      await tasks.setConditionWithClient(c,actor,sewing.taskId,"handover_received",true,at);
      await tasks.setConditionWithClient(c,actor,sewing.taskId,"business_recorded",true,at);
      const confirmation=await tasks.createWithClient(c,actor,{resource,kind:"development_confirmation",routeId,routeVersion:1,occurrence:1,assigneeId:designer,predecessors:[sewing.taskId]});
      await tasks.setConditionWithClient(c,actor,confirmation.taskId,"business_recorded",true,null);
    }
    await c.query("COMMIT");
  }catch(e){await c.query("ROLLBACK");throw e;}finally{c.release();}
  console.log(JSON.stringify({fixture:"TEST-A1-P03",sourceId:source.sourceId,orderId:order.productionOrderId}));
}finally{await pool.end();}
