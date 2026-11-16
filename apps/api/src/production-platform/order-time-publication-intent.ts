import {initialCustomerOrderInput,initialCustomerOrderIsReady,type CustomerOrderCalendar,type DigitalOrderInput} from '@dx-rework/contracts/digital-production';
import type {DevelopmentDocument} from '@dx-rework/contracts/digital-development';

/** Publication can retain an incomplete ordering draft. A combined formal
 * operation is planned/executed only for the same already-complete intent. */
export function publicationFormalInput(document:DevelopmentDocument|null|undefined,calendar:CustomerOrderCalendar,framework:boolean):DigitalOrderInput|null{
 if(!document)return null;
 const draft=document.customerOrderDraft;
 if(!draft?.withOrder||draft.stage==='preorder'||!initialCustomerOrderIsReady(draft.order,calendar))return null;
 const route=document.productionPlanning;
 if(framework&&(typeof draft.order.requiresColorMatching!=='boolean'||!route||route.craftSteps===null||route.preshrink===null))return null;
 return {...initialCustomerOrderInput(draft.order),...(route?{productionPlanning:structuredClone(route)}:{})};
}
