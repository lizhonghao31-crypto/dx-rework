import {SERIES_MILESTONES} from '@dx-rework/contracts/digital-series-plan';
import type {OrderTimeConfiguration} from '@dx-rework/contracts/order-time-settings';

/** Uses the existing settings table, authority state and save action. */
export function OrderTimeMilestoneFields({value,disabled=false,onChange}:{value:OrderTimeConfiguration;disabled?:boolean;onChange(value:OrderTimeConfiguration):void}){
 const framework=value.framework;if(!framework)return null;
 return <details className="r5-route-fields"><summary>里程碑时间</summary><div className="r5-table-scroll"><table><thead><tr><th>里程碑</th><th>需要对色 · 提前天数</th><th>不需要对色 · 提前天数</th></tr></thead><tbody>{SERIES_MILESTONES.map(node=><tr key={node.key}><th>{node.key==='planned_shipment'?'交付客户':node.label}</th>{(['A','B'] as const).map(route=>{
  const days=framework.milestoneOffsets[route][node.key];
  return <td key={route}>{days===null?'不适用':node.key==='planned_shipment'?'客户交货日期':node.key==='material_investment'?'按适用采购周期倒推':<input aria-label={node.label+(route==='A'?'需要对色':'不需要对色')+'提前天数'} type="number" min={0} max={365} step={1} disabled={disabled} value={Number.isFinite(days)?days:''} onChange={event=>onChange({...value,framework:{...framework,milestoneOffsets:{...framework.milestoneOffsets,[route]:{...framework.milestoneOffsets[route],[node.key]:event.target.value===''?Number.NaN:Number(event.target.value)}}}})}/>}</td>;
 })}</tr>)}</tbody></table></div></details>;
}
