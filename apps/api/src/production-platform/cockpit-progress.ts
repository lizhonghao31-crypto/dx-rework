import type { DigitalTask } from "@dx-rework/contracts/digital-production-tasks";
/** Whole-order nodes count once, irrespective of PO count. Technical applicability is frozen by the approved route. */
export function bulkCockpitProgress(input:{preshrink:string;secondaryCraft:string;externalCutting:boolean;tasks:DigitalTask[];received:boolean;packed:boolean;specialClosed:boolean}) {
  const nodes=['bulk_pattern',...(input.preshrink==='需要预缩'?['warehouse_preshrink']:[]),input.externalCutting?'bulk_cutting_external':'bulk_cutting',
    ...(input.secondaryCraft!=='无'?['process_logistics','bulk_qc']:[]),'warehouse_dispatch','bulk_ship_sample'];
  const completed=nodes.filter(node=>input.tasks.some(task=>task.taskKind===node&&task.state==='completed')).length;
  return {applicable:nodes.length+2,completed:completed+Number(input.received)+Number(input.packed&&!input.specialClosed)};
}
