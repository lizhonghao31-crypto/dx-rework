import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {DevelopmentMaterial} from '@dx-rework/contracts/digital-development';
import type {QuotationMaterialPricingUnit} from '@dx-rework/contracts/digital-quotation';

const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const correctionSchema=z.object({unit:z.string().trim().min(1).max(100),sourceUnit:z.string().max(100),materialBasis:z.string().regex(/^[0-9a-f]{64}$/),actorId:z.string().uuid(),version:z.number().int().positive(),recordedAt:z.iso.datetime({offset:true})}).strict();

/** Commercial correction follows this physical material, never another row or a
 * later source unit. Scheduling, task assignment and other crafts are unrelated. */
export function quotationMaterialUnitBasis(material:DevelopmentMaterial){
 return digest([material.materialId,material.category,material.name,material.specification,material.width,material.weight,material.composition,material.color]);
}
export function quotationMaterialPricingUnit(material:DevelopmentMaterial,raw:QuotationMaterialPricingUnit|undefined){
 if(!raw)return undefined;
 const correction=correctionSchema.parse(raw);
 return correction.materialBasis===quotationMaterialUnitBasis(material)&&correction.sourceUnit===(material.pricingUnit??'')?correction:undefined;
}
export function quotationMaterialPriceBasis(material:DevelopmentMaterial,unit:string){
 return digest([material.unitPrice??'',unit,material.materialId,material.name,material.specification,material.supplier]);
}
