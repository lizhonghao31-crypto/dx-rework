import type { JourneyNode } from "@dx-rework/contracts/digital-production-journey";
export function patternTaskAction(node: Pick<JourneyNode,"key"|"state">): string {
  if(node.state==="completed")return "查看办理记录";
  if(node.state==="pending")return "查看等待条件";
  if(node.state==="blocked")return "查看问题与恢复";
  return ({development_materials:"核对面辅料",development_material_recheck:"复核面辅料",development_material_supply:"登记补料",development_pattern:"做纸样",development_cutting:"做裁板",development_sewing_transfer:"分派与转交车缝",development_sewing:"做车缝",development_tail_check:"检查样板",development_washing:"完成洗水",development_washing_dispatch:"登记送洗",development_shipping:"记录寄样",development_confirmation:"确认本轮样板"} as Record<string,string>)[node.key]??"办理当前工序";
}
