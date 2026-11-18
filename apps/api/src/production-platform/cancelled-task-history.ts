import type {OrderJourney} from '@dx-rework/contracts/digital-production-journey';
import type {JourneyTermination} from './journey-termination.js';

export type SourceTaskCancelEvent={id:string;at:string|null;quality:string};
type Task={task_id:string;state:string;task_kind:string;source_id:string|null;production_order_id:string|null;route_version:number;route_instance_id:string;step_id?:string|null;cancel_events?:string[];source_cancel_events?:SourceTaskCancelEvent[]};

/** Both readers already load this task and its access row in the same snapshot.
 * Select at most two events so an ambiguous original never supplies a clock. */
export const sourceTaskCancellationEventsSql=`ARRAY(SELECT jsonb_build_object('id',e.event_id,'at',e.occurred_at,'quality',e.time_quality)
 FROM digital_production_task_events e WHERE $3='order' AND t.state='cancelled' AND e.task_id=t.task_id
 AND e.resource_kind='source' AND e.resource_id=a.source_id AND e.event_kind='cancel'
 AND EXISTS(SELECT 1 FROM digital_production_resource_lifecycle l WHERE l.resource_kind='source' AND l.resource_id=a.source_id AND l.state='cancelled')
 ORDER BY e.event_id LIMIT 2)`;
/** A frozen duration key is not necessarily a native task kind. The exact
 * original route position is authoritative when available; typed work retains
 * its original step identity and only normalizes known parameter aliases. */
export function cancelledWorkTaskKind(parameterKey:string,workId:string,routeKind?:string):string{
 if(routeKind)return routeKind;
 const raw=workId.startsWith('source:')?workId.slice(7):workId;
 if(raw==='development_material_recheck')return raw;
 if(['bulk_printing','bulk_embroidery','bulk_print_embroidery'].includes(parameterKey)||parameterKey.startsWith('bulk_special_'))return 'process_logistics';
 if(parameterKey==='development_craft_return')return 'development_craft_confirmation';
 if(parameterKey.startsWith('development_special_'))return 'development_printing';
 return parameterKey;
}
/** A resource cancellation is not evidence that every historical task belongs
 * to it. Require its own original cancel event and exact current read identity.
 * Unknown stop precision still permits reading the independently known R/D. */
export function cancelledTaskHistory(task:Task,resource:{kind:'source'|'order';id:string},item:OrderJourney,termination:JourneyTermination|null|undefined,key:string,lineId?:string|null,canonicalWorkRef?:string):boolean{
 if(task.state!=='cancelled'||termination?.kind!=='cancelled'||termination.scopeRef!==`${resource.kind}:${resource.id}`||task.cancel_events?.length!==1)return false;
 if(resource.kind==='source'?task.source_id!==resource.id:task.production_order_id!==resource.id)return false;
 if(task.task_kind!==key&&!(key==='bulk_cutting'&&task.task_kind==='bulk_cutting_external'))return false;
 if(canonicalWorkRef?.startsWith('order:')&&!canonicalWorkRef.startsWith(`order:${resource.id}:`))return false;
 const source=canonicalWorkRef?.match(/^source:([^:]+):round:(\d+):/);
 if(source&&(resource.kind!=='source'||source[1]!==resource.id||Number(source[2])!==task.route_version))return false;
 const route=canonicalWorkRef?.match(/:route:([^:]+):/)?.[1];
 if(route&&route!==task.route_instance_id)return false;
 const step=canonicalWorkRef?.match(/:step:([^:]+):/)?.[1];
 if(step&&step!==task.step_id)return false;
 const nodes=item.stages.flatMap(stage=>stage.nodes).filter(node=>node.current&&node.state==='cancelled'&&node.instanceId===task.task_id
  &&(node.round===null||node.round===task.route_version)&&!node.inheritedFrom
  &&node.records.some(record=>record.domain==='task'&&record.id===task.task_id&&record.version===task.route_version));
 if(nodes.length!==1)return false;
 const lines=new Set(nodes[0]!.records.flatMap(record=>record.lineId?[record.lineId]:[]));
 return !lineId||!lines.size||lines.has(lineId);
}

/** A linked order can be open after its development source was cancelled.
 * Each PO may reference the same original source work, but only an exact
 * canonical reference and the visible current task can carry its own stop. */
export function linkedSourceTaskCancellation(task:Task,resource:{kind:'source'|'order';id:string},item:OrderJourney,key:string,asOf:string,lineId:string|null,canonicalWorkRef?:string):JourneyTermination|null{
 if(resource.kind!=='order'||item.orderId!==resource.id||!item.sourceId||task.source_cancel_events?.length!==1)return null;
 if(!canonicalWorkRef?.startsWith(`source:${item.sourceId}:round:${task.route_version}:`))return null;
 const event=task.source_cancel_events[0]!,source={kind:'source' as const,id:item.sourceId};
 const time=event.at?Date.parse(event.at):NaN;
 const at=['现场登记','已核实'].includes(event.quality)&&Number.isFinite(time)&&time<=Date.parse(asOf)?new Date(time).toISOString():null;
 const termination={kind:'cancelled' as const,at,precision:at?'instant' as const:'unknown' as const,originEventRef:`digital_production_task_events:${event.id}`,scopeRef:`source:${source.id}`};
 return cancelledTaskHistory({...task,cancel_events:[event.id]},source,item,termination,key,lineId,canonicalWorkRef)?termination:null;
}
