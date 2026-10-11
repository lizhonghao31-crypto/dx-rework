import {DigitalIdSchema} from '@dx-rework/contracts/digital-production';
import type {PoDeliveryDate} from '@dx-rework/contracts';
export function productionLineTarget(search:string,dates:readonly PoDeliveryDate[]|undefined):{lineId:string|null;position:number|null;error:string|null}{
 const query=new URLSearchParams(search),lineId=query.get('line');
 if(lineId===null)return {lineId:null,position:null,error:null};
 if(query.getAll('line').length!==1||!DigitalIdSchema.safeParse(lineId).success)return {lineId,position:null,error:'PO编号无效，请从原订单重新进入'};
 const matched=dates?.find(line=>line.lineId===lineId);
 return matched?.position?{lineId,position:matched.position,error:null}:{lineId,position:null,error:'该PO没有当前生产关联，请刷新原订单；不能按颜色或行号猜测'};
}
