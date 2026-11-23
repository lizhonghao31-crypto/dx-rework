import {isDeepStrictEqual} from 'node:util';
import type {DevelopmentDocument} from '@dx-rework/contracts/digital-development';

/** Price visibility or a price edit does not change the physical material. */
export function withoutDevelopmentMaterialPrice(material:DevelopmentDocument['materials'][number]){
 const copy={...material};delete copy.unitPrice;
 if(copy.auxiliaryCatalog){
  const {id,version}=copy.auxiliaryCatalog;
  copy.auxiliaryCatalog={id,version};
 }
 return copy;
}

/** Technical documents are shared with workers; commercial prices are not. */
export function withoutDevelopmentPrices(document:DevelopmentDocument):DevelopmentDocument{
 return {...document,materials:document.materials.map(withoutDevelopmentMaterialPrice)};
}

export function sameDevelopmentMaterialBasis(a:DevelopmentDocument['materials'][number],b:DevelopmentDocument['materials'][number]){
 const physical=(material:typeof a)=>{
  const {auxiliaryCatalog,...facts}=withoutDevelopmentMaterialPrice(material);
  delete facts.pricingUnit;
  return {...facts,catalogId:auxiliaryCatalog?.id};
 };
 return isDeepStrictEqual(physical(a),physical(b));
}
