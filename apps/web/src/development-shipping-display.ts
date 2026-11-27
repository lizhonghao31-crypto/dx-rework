import type {DevelopmentShippingDisplay} from '@dx-rework/contracts/digital-development-workspace';

export const developmentShippingLabel={sent:'已寄出',wait_tail:'待尾查',wait_design:'待设计确认',unassigned:'待分派',
 ready:'待寄出',not_applicable:'不适用',paused:'已暂停',cancelled:'已取消',unknown:'待核对'} satisfies Record<DevelopmentShippingDisplay['state'],string>;
export function developmentShippingTone(state:DevelopmentShippingDisplay['state']){
 return state==='sent'?'success':state==='ready'?'danger':state==='unassigned'?'warning':'neutral';
}
