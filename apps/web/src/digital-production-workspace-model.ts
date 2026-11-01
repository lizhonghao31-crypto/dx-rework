import type { JourneyNode, OrderJourney } from '@dx-rework/contracts/digital-production-journey';
import { nodeStatus } from './digital-journey-cockpit-model.js';
export type ProductionWorkspaceKind = 'preparation' | 'factory';
export const productionWorkspaceGroups = {
 preparation: [
  {label:'预算与外发定价', keys:['budget','sourcing_preparation','sourcing_ie','sourcing_director','sourcing_owner']},
  {label:'客户确认与制单', keys:['customer_sample','production_instruction']},
  {label:'大货纸样 / 唛架', keys:['bulk_pattern','bulk_marker']},
  {label:'预缩 / 无需预缩', keys:['warehouse_preshrink']},
  {label:'开裁条件汇合', keys:['cutting_gate']},
 ],
 factory: [
  {label:'整款实裁', keys:['bulk_cutting']},
  {label:'二次工艺收发', keys:['process_logistics']},
  {label:'工艺 QC / 处理 / 复查', keys:['bulk_qc']},
  {label:'仓库实际发厂', keys:['warehouse_dispatch']},
  {label:'QC生产进度 / 成衣检查', keys:['production_reporting','factory_production_qc']},
  {label:'船样', keys:['bulk_ship_sample']},
 ],
} as const;
export function workspaceGroupNodes(order: OrderJourney, keys: readonly string[]): JourneyNode[] {
 return order.stages.flatMap(stage=>stage.nodes).filter(node=>node.current&&keys.includes(node.key));
}
export function workspaceGroupStatus(nodes: JourneyNode[], asOf?: string): string {
 if (!nodes.length) return '尚无原事实';
 if (nodes.length===1) return nodeStatus(nodes[0]!,asOf);
 if (nodes.some(node=>node.state==='unavailable')) return '部分事实不可见';
 const applicable=nodes.filter(node=>!['not_applicable','cancelled'].includes(node.state));
 if (!applicable.length) return '不适用';
 if (applicable.every(node=>['completed','inherited'].includes(node.state))) return '已完成';
 if (applicable.some(node=>node.state==='blocked')) return '受阻';
 if (applicable.some(node=>node.state==='active')) return '进行中';
 return '待前置';
}
