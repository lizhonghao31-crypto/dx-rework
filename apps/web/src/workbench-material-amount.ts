import {formatBusinessDecimal} from '@dx-rework/contracts/business-display';
import {developmentMaterialLineTotal,type DevelopmentMaterial} from '@dx-rework/contracts/digital-development';

type MaterialPrice = Pick<DevelopmentMaterial,'quantity'|'quantityUnit'|'unitPrice'|'pricingUnit'>;

/** A read-only line total. A suffix is an explicit legacy unit, not a default. */
export function workbenchMaterialAmount(material:MaterialPrice):{exact:string;label:string}|null{
 const exact=developmentMaterialLineTotal(material);
 if(exact===null)return null;
 const rounded=formatBusinessDecimal(exact,1).replaceAll(',','');
 return {exact,label:exact!=='0'&&rounded==='0'?'小于 0.1':rounded};
}
