import type {PoolClient} from 'pg';
import type {BusinessTimeScope} from '@dx-rework/domain/business-clock';
import {FixedTimelineAdoptionRepository} from './fixed-timeline-adoptions.js';
import {readFixedOrderRoute} from './fixed-order-route.js';
import {developmentNativeRoute} from './development-native-route.js';

type DB=Pick<PoolClient,'query'>;

/** Native callers retain authorization and the lifecycle lock. A position is
 * local to the immutable route; repeated craft handoffs are not kind.indexOf.
 */
export async function prepareFixedTaskPosition(db:DB,input:{resource:BusinessTimeScope;routeId:string;routeVersion:number;kind:string;predecessors?:string[];routePosition?:number}){
 // Source rounds adopt independently; later instruction versions on one order
 // continue its original adoption and bind a separate immutable route scope.
 const order=input.resource.kind==='order'?await new FixedTimelineAdoptionRepository(db).existing(input.resource,1):null;
 const saved=order??(input.resource.kind==='source'?await developmentNativeRoute(db,input.resource.id,input.routeVersion):null);
 if(!saved)return null;
 const scope=order&&saved.input.sourceVersions.routeRef!==input.routeId?await readFixedOrderRoute(db,order,input.routeId):null;
 if(saved.input.sourceVersions.routeRef!==input.routeId&&!scope)return null;
 const route=scope?.route??saved.input.route??[];
 if(!route.some(position=>position.kind===input.kind))return null;
 const occupied=(await db.query('SELECT route_position,task_id FROM digital_timeline_task_positions WHERE route_ref=$1 AND route_version=$2',[input.routeId,input.routeVersion])).rows;
 const predecessors=new Set(input.predecessors??[]);
 const previous=Math.max(-1,...occupied.filter(position=>predecessors.has(position.task_id)).map(position=>Number(position.route_position)));
 const position=input.routePosition===undefined?route.find(position=>position.kind===input.kind&&position.position>previous&&!occupied.some(row=>row.route_position===position.position)):route.find(position=>position.position===input.routePosition&&position.kind===input.kind);
 if(!position||occupied.some(row=>row.route_position===position.position))throw Error('本轮该位置的任务已经存在或不属于原冻结路线');
 if(position.position>0&&previous>=0&&position.position!==previous+1)throw Error('后继任务必须沿本轮原冻结路线');
 const column=input.resource.kind==='source'?'source_id':'production_order_id';
 const occurrence=Number((await db.query(`SELECT coalesce(max(t.occurrence),0)+1 AS next FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE a.${column}=$1 AND a.task_kind=$2`,[input.resource.id,input.kind])).rows[0].next);
 return {saved,position,occurrence,routeVersion:input.routeVersion,routeId:input.routeId};
}

export async function insertFixedTaskPosition(db:DB,taskId:string,prepared:NonNullable<Awaited<ReturnType<typeof prepareFixedTaskPosition>>>) {
 const {saved,position}=prepared;
 await db.query(`INSERT INTO digital_timeline_task_positions(task_id,adoption_id,route_ref,route_version,route_position,step_id,phase) VALUES($1,$2,$3,$4,$5,$6,$7)`,
  [taskId,saved.adoptionId,prepared.routeId,prepared.routeVersion,position.position,position.stepId??null,position.phase??null]);
}
