import {DigitalIdSchema} from "@dx-rework/contracts/digital-production";
import {BulkWashingWindowReferenceSchema} from '@dx-rework/contracts/bulk-washing';
export const factoryActions=['overview','logistics','qc','dispatch','followup','productionQc','productionProgress','washing'] as const;
export type FactoryTaskTarget={action:typeof factoryActions[number];lineId:string|null;error:string|null;washingWindow?:string;factoryId?:string};
export function factoryTaskTarget(search:string):FactoryTaskTarget{
 const params=new URLSearchParams(search),action=params.get('factoryAction')??'overview',lineId=params.get('line');
 if(params.getAll('factoryAction').length>1||params.getAll('line').length>1||!(factoryActions as readonly string[]).includes(action)||lineId!==null&&!DigitalIdSchema.safeParse(lineId).success)return {action:'overview',lineId:null,error:'办理位置或PO编号无效，请从原订单或岗位待办重新进入'};
 if(params.has('washingWindow')){
  const reference=params.get('washingWindow'),factoryId=params.get('factory');
  if(action!=='washing'||!lineId||params.getAll('washingWindow').length!==1||params.getAll('factory').length!==1||!DigitalIdSchema.safeParse(factoryId).success||!BulkWashingWindowReferenceSchema.safeParse(reference).success)return {action:'overview',lineId:null,error:'洗水窗口位置无效，请从原订单的对应窗口重新进入'};
  return {action:'washing',lineId,factoryId:factoryId!,washingWindow:reference!,error:null};
 }
 return {action:action as FactoryTaskTarget['action'],lineId,error:null};
}
export function factoryTaskAction(kind:string):FactoryTaskTarget['action']{
 return kind==='factory_production_qc'?'productionProgress':kind==='process_logistics'?'logistics':kind==='bulk_qc'?'qc':kind==='warehouse_dispatch'?'dispatch':kind==='bulk_ship_sample'?'followup':'overview';
}
