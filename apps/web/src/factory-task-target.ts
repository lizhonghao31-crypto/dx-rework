import {DigitalIdSchema} from "@dx-rework/contracts/digital-production";
export const factoryActions=['overview','logistics','qc','dispatch','followup','productionQc'] as const;
export type FactoryTaskTarget={action:typeof factoryActions[number];lineId:string|null;error:string|null};
export function factoryTaskTarget(search:string):FactoryTaskTarget{
 const params=new URLSearchParams(search),action=params.get('factoryAction')??'overview',lineId=params.get('line');
 if(params.getAll('factoryAction').length>1||params.getAll('line').length>1||!(factoryActions as readonly string[]).includes(action)||lineId!==null&&!DigitalIdSchema.safeParse(lineId).success)return {action:'overview',lineId:null,error:'办理位置或PO编号无效，请从原订单或岗位待办重新进入'};
 return {action:action as FactoryTaskTarget['action'],lineId,error:null};
}
export function factoryTaskAction(kind:string):FactoryTaskTarget['action']{
 return kind==='factory_production_qc'?'productionQc':kind==='process_logistics'?'logistics':kind==='bulk_qc'?'qc':kind==='warehouse_dispatch'?'dispatch':['factory_material_count','bulk_ship_sample'].includes(kind)?'followup':'overview';
}
