import type {PoolClient} from 'pg';
import type {JourneyNode} from '@dx-rework/contracts/digital-production-journey';
import {SERIES_MILESTONES,type SeriesPlanSnapshot} from '@dx-rework/contracts/digital-series-plan';
import {readSeriesPlanFacts} from './series-plan-facts.js';
/** Read-only date projection, excluded from execution completion denominators and all native gates. */
export async function seriesPlanJourney(db:Pick<PoolClient,'query'>,id:string,day:string,closed:boolean):Promise<JourneyNode[]>{
 if(!(await db.query("SELECT to_regclass('digital_series_plans') AS t")).rows[0]?.t)return [];
 const order=(await db.query('SELECT * FROM digital_production_orders WHERE production_order_id=$1',[id])).rows[0];
 const plan:SeriesPlanSnapshot|undefined=(await db.query('SELECT snapshot_json FROM digital_series_plans WHERE production_order_id=$1 ORDER BY revision DESC LIMIT 1',[id])).rows[0]?.snapshot_json;
 if(!order||!plan&&!order.sales_series)return [];
 const actual=await readSeriesPlanFacts(db,id,order.source_id,order.customer_code),warehouse=(await db.query('SELECT warehouse_worker_id FROM digital_bulk_dispatch WHERE production_order_id=$1',[id])).rows[0]?.warehouse_worker_id;
 const ownerIds=[order.created_by,order.primary_merchandiser_id,warehouse].filter((v):v is string=>Boolean(v));
 const names=new Map<string,string>((await db.query('SELECT id,display_name FROM app_users WHERE id=ANY($1::uuid[])',[ownerIds])).rows.map(r=>[r.id,r.display_name]));
 return SERIES_MILESTONES.filter(m=>m.key!=='color_confirmation'||(plan?.route==='A'||!plan&&order.requires_color_matching!==false)).map(m=>{
  const target=plan?.milestones.find(n=>n.key===m.key&&n.scopeRef==='whole'),facts=actual.facts.filter(f=>f.key===m.key&&f.scopeRef==='whole'),completed=facts.some(f=>f.completed),started=facts.some(f=>f.started),f=facts.find(f=>f.completed)??facts[0];
  const date=target?.targetDate??null,overdue=!closed&&!completed&&date!==null&&date<day;
  const ownerId=m.role.startsWith('设计')?order.created_by:m.role.startsWith('订单跟单')?order.primary_merchandiser_id:warehouse;
  return {planningOnly:true,key:`series_${m.key}`,instanceId:`series:${id}:${m.key}`,label:m.label,stage:m.key==='processing_dispatch'?'post_cutting':m.key==='planned_shipment'?'receiving':'preparation',state:completed?'completed':started?'active':'pending',round:null,occurrence:null,current:!closed,
   owner:ownerId?{id:ownerId,name:names.get(ownerId)??null}:null,operator:null,responsibilityRole:m.role,assignmentHistory:[],expectedAt:date,expectedKind:date?'plan':'unset',expectedPrecision:date?'date':'missing',
   actualAt:f?.occurredAt??null,actualDate:f?.occurredDate??null,actualQuality:f?.occurredAt||f?.occurredDate?'unverified':'missing',enteredAt:null,sla:completed?'finished':'not_set',completionResult:completed?'unknown':null,overdueSeconds:null,
   risks:overdue?['overdue']:!date||completed&&f?.precision==='unknown'?['unknown']:[],blockers:[],records:[{domain:'series-plan',id,url:`/ui/digital-cockpit?selected=${id}#series-plan-${id}`,mode:'read',version:plan?.revision??null,lineId:null}],inheritedFrom:null,countsInProgress:false,progressApplicability:'unknown',unavailableReason:null};
 });
}
