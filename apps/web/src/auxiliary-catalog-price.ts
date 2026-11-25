import type {AuxiliaryItem} from '@dx-rework/contracts/auxiliary-catalog';
import {formatBusinessDecimal} from '@dx-rework/contracts/business-display';

/** Format the visible reference without rounding the stored value or the input. */
export function auxiliaryPriceText(price:AuxiliaryItem['referencePricing']){
 if(!price)return '未记录';
 const amount=/^0\.0\d*$/.test(price.amount)&&/[1-9]/.test(price.amount)?'<0.1':formatBusinessDecimal(price.amount,1);
 return `${amount} 元 / ${price.unit}`;
}
