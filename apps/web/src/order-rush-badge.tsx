import {StatusBadge} from '@dx-rework/ui';

export function OrderRushBadge({value}:{value?:boolean|undefined}){
 return value===true?<StatusBadge tone="danger">急单</StatusBadge>:null;
}
