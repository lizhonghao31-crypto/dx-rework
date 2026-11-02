import type {Pool} from 'pg';
import type {TrustedActorContext} from '../../apps/api/src/tools/repositories.js';
import {DigitalJourneyQuery} from '../../apps/api/src/production-platform/journey-query.js';
import {NodeMaterialsSchema} from '@dx-rework/contracts/digital-production-journey';
export async function nodeMaterialsFixture(db:Pool,actor:TrustedActorContext,id:string,key:string,taskId?:string){
 const query=new DigitalJourneyQuery(db),order=await query.read(actor,id),nodes=order.stages.flatMap(s=>s.nodes);
 const node=nodes.find(n=>n.key===key&&(taskId?n.records.some(r=>r.domain==='task'&&r.id===taskId):n.current));
 if(!node)throw new Error(`TEST visible ${key} instance not found`);
 const data=NodeMaterialsSchema.parse(await query.nodeMaterials(actor,order.id,node.instanceId,order.selectedRound??undefined));
 return {data,order,node,query};
}
/** Compare the actual task/plan/fact/todo/risk footprint, not merely HTTP method. */
export async function nodeMaterialsFootprint(db:Pool){
 const names=(await db.query("SELECT schemaname,tablename FROM pg_tables WHERE schemaname=current_schema() AND (tablename ~ '^digital_.*(task|preparation|series|risk|command|lifecycle)' OR tablename ~ 'notification|audit_events') ORDER BY tablename")).rows as Array<{schemaname:string;tablename:string}>;
 const quote=(s:string)=>'"'+s.replaceAll('"','""')+'"';
 const state:Record<string,string|null>={};
 for(const {schemaname,tablename} of names)state[tablename]=(await db.query(`SELECT md5(coalesce(string_agg(to_jsonb(t)::text,chr(10) ORDER BY to_jsonb(t)::text),'')) AS h FROM ${quote(schemaname)}.${quote(tablename)} t`)).rows[0].h;
 if(!Object.hasOwn(state,'digital_production_tasks')||!Object.hasOwn(state,'digital_preparation_material_versions'))throw new Error('TEST real workflow footprint missing');
 return state;
}
