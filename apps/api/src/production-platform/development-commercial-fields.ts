import type {DevelopmentDocument} from '@dx-rework/contracts/digital-development';

/** Price visibility or a price edit does not change the physical material. */
export function withoutDevelopmentMaterialPrice(material:DevelopmentDocument['materials'][number]){
 const copy={...material};delete copy.unitPrice;return copy;
}

/** Technical documents are shared with workers; commercial prices are not. */
export function withoutDevelopmentPrices(document:DevelopmentDocument):DevelopmentDocument{
 return {...document,materials:document.materials.map(withoutDevelopmentMaterialPrice)};
}
