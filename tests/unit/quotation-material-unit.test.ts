import {randomUUID} from 'node:crypto';
import {expect,it} from 'vitest';
import {DevelopmentMaterialSchema} from '../../packages/contracts/src/digital-development.js';
import {quotationMaterialUnitBasis,quotationMaterialPricingUnit,quotationMaterialPriceBasis} from '../../apps/api/src/production-platform/quotation-material-unit.js';

const material=DevelopmentMaterialSchema.parse({materialId:randomUUID(),category:'主布',label:'TEST主料',supplier:'TEST',name:'TEST棉',width:'150',weight:'200',composition:'棉',consumption:'',color:'黑',specification:'40支',quantity:'1',requiredThisRound:true,available:true,expectedDate:null,unitPrice:'20'});
const correction=()=>({unit:'米',sourceUnit:'',materialBasis:quotationMaterialUnitBasis(material),actorId:randomUUID(),version:2,recordedAt:'2026-11-15T10:00:00.000Z'});
it('reads additive unit provenance on the same physical material without treating availability, dates or price as physical replacement',()=>{
 const value=correction();expect(quotationMaterialPricingUnit(material,value)).toEqual(value);
 expect(quotationMaterialPricingUnit({...material,unitPrice:'22',available:false,expectedDate:'2027-01-01'},value)).toEqual(value);
 expect(quotationMaterialPricingUnit(material,undefined)).toBeUndefined();
});
it('never carries a correction to another material, physical specification or changed native unit',()=>{
 for(const next of [{...material,materialId:randomUUID()},{...material,specification:'32支'},{...material,pricingUnit:'码'}])expect(quotationMaterialPricingUnit(next,correction())).toBeUndefined();
});
it('keeps exact units and rejects unreadable provenance instead of guessing a conversion',()=>{
 const value={...correction(),unit:'m'};expect(quotationMaterialPricingUnit(material,value)?.unit).toBe('m');
 for(const bad of [{...value,unit:''},{...value,actorId:'unknown'},{...value,version:0},{...value,recordedAt:'2026-11-15'}])expect(()=>quotationMaterialPricingUnit(material,bad)).toThrow();
});
it('binds material price overrides to source price and the exact effective unit while preserving a real zero',()=>{
 expect(quotationMaterialPriceBasis(material,'米')).not.toBe(quotationMaterialPriceBasis(material,'码'));
 expect(quotationMaterialPriceBasis(material,'米')).not.toBe(quotationMaterialPriceBasis({...material,unitPrice:'22'},'米'));
 expect(quotationMaterialPriceBasis({...material,unitPrice:'0'},'米')).not.toBe(quotationMaterialPriceBasis({...material,unitPrice:''},'米'));
});
