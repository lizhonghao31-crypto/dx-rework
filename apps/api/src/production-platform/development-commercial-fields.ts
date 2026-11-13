import type {DevelopmentDocument} from '@dx-rework/contracts/digital-development';

/** Technical documents are shared with workers; commercial prices are not. */
export function withoutDevelopmentPrices(document:DevelopmentDocument):DevelopmentDocument{
 return {...document,materials:document.materials.map(material=>{const copy={...material};delete copy.unitPrice;return copy;})};
}
