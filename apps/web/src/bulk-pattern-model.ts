import type {BulkPreparationSheet} from '@dx-rework/contracts/bulk-preparation';
export const bulkPatternLanes=[{key:'preparing',label:'待准备',color:'materials'},{key:'dispatch',label:'待派交',color:'cutting'},{key:'handling',label:'办理中',color:'craft'},{key:'completed',label:'已完成',color:'shipping'}] as const;
/** Display classification only: two independent results never imply whole-order completion. */
export function bulkPatternLane(sheet:BulkPreparationSheet):typeof bulkPatternLanes[number]['key']{
 if(sheet.facts.some(f=>f.kind==='纸样完成')&&sheet.facts.some(f=>f.kind==='唛架完成'))return 'completed';
 if(sheet.reasons.length||!sheet.preparationId)return 'preparing';
 if(!sheet.facts.some(f=>f.kind==='纸样派交'))return 'dispatch';
 return 'handling';
}
