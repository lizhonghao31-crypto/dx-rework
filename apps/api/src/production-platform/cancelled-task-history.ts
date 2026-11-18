import type {OrderJourney} from '@dx-rework/contracts/digital-production-journey';
import type {JourneyTermination} from './journey-termination.js';

type Task={task_id:string;state:string;task_kind:string;source_id:string|null;production_order_id:string|null;route_version:number;route_instance_id:string;cancel_events?:string[]};
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
 const nodes=item.stages.flatMap(stage=>stage.nodes).filter(node=>node.current&&node.state==='cancelled'&&node.instanceId===task.task_id
  &&(node.round===null||node.round===task.route_version)&&!node.inheritedFrom
  &&node.records.some(record=>record.domain==='task'&&record.id===task.task_id&&record.version===task.route_version));
 if(nodes.length!==1)return false;
 const lines=new Set(nodes[0]!.records.flatMap(record=>record.lineId?[record.lineId]:[]));
 return !lineId||!lines.size||lines.has(lineId);
}
