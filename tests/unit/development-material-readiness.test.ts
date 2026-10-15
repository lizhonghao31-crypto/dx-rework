import {describe,it,expect} from 'vitest';
import {DevelopmentMaterialSchema,isEarlyMaterialException,type DevelopmentDocument,type DevelopmentMaterial} from '@dx-rework/contracts/digital-development';
import {effectiveMaterials,materialCheckError} from '../../apps/api/src/production-platform/development-material-readiness.js';
const material=(patch:Partial<DevelopmentMaterial>={}):DevelopmentMaterial=>({materialId:'00000000-0000-4000-8000-000000000001',category:'主布',label:'主布A',supplier:'',name:'棉布',width:'',weight:'',composition:'',consumption:'',color:'黑',specification:'',quantity:'1',requiredThisRound:true,available:false,expectedDate:null,...patch});
const doc=(row:DevelopmentMaterial)=>({materials:[row]} as DevelopmentDocument);
const checked=(row:DevelopmentMaterial,physical=true)=>({materialId:row.materialId,physical,quantity:true,color:true,specification:true});
describe('R2 material evidence',()=>{
  it('uses a complete check despite no published physical stock or arrival event',()=>{
    const row=material();expect(effectiveMaterials(doc(row),[{id:'check',kind:'核配通过',items:[checked(row)],at:'2026-10-15T00:00:00Z'}])[0]).toMatchObject({available:true,verified:true,evidenceId:'check',missing:[]});
  });
  it('does not invent checks from published stock or an arrival',()=>{
    const row=material({available:true});expect(effectiveMaterials(doc(row),[{id:'arrival',kind:'到货',materialId:row.materialId,at:'2026-10-15T00:00:00Z'}])[0]).toMatchObject({available:false,verified:false,missing:['尚未逐项核验']});
  });
  it('never infers an exception from a free label or allows a cloth subtype',()=>{
    const row=material({category:'辅料',label:'拉链'});
    expect(isEarlyMaterialException(row)).toBe(false);
    expect(materialCheckError(row,checked(row,false),'缺料','2026-10-16')).toContain('实物');
    expect(DevelopmentMaterialSchema.safeParse(material({auxiliaryKind:'拉链'})).success).toBe(false);
  });
  it.each(['拉链','扁机'] as const)('records missing %s and waits for a later authorized arrival/substitution',auxiliaryKind=>{
    const row=material({category:'辅料',auxiliaryKind,expectedDate:'2026-10-16'}),items=[checked(row,false)];
    expect(materialCheckError(row,items[0],'缺料由设计师跟进',row.expectedDate)).toBeNull();
    expect(materialCheckError(row,items[0],'',row.expectedDate)).toContain('缺项说明');
    const check={id:'check',kind:'核配通过',items,at:'2026-10-15T01:00:00Z'};
    expect(effectiveMaterials(doc(row),[check])[0]).toMatchObject({earlyAllowed:true,available:false});
    expect(effectiveMaterials(doc(row),[check,{id:'old',kind:'到货',materialId:row.materialId,at:'2026-10-15T00:00:00Z'}])[0]?.available).toBe(false);
    for(const kind of ['到货','确认代用'])expect(effectiveMaterials(doc(row),[check,{id:'new',kind,materialId:row.materialId,at:'2026-10-15T02:00:00Z'}])[0]).toMatchObject({available:true,evidenceId:'new'});
  });
  it('does not let a later arrival erase a known specification defect',()=>{
    const row=material({category:'辅料',auxiliaryKind:'拉链'}),items=[{...checked(row),specification:false}];
    expect(materialCheckError(row,items[0],'规格不符',null)).toContain('规格');
    expect(effectiveMaterials(doc(row),[{id:'check',kind:'缺项退回',items,at:'2026-10-15T01:00:00Z'},{id:'arrival',kind:'到货',materialId:row.materialId,at:'2026-10-15T02:00:00Z'}])[0]?.available).toBe(false);
  });
  it('matches stable IDs rather than identical material names',()=>{
    const old=material(),current=material({materialId:'00000000-0000-4000-8000-000000000002'});
    expect(effectiveMaterials(doc(current),[{id:'check',kind:'核配通过',items:[checked(old)],at:'2026-10-15T01:00:00Z'}])[0]?.available).toBe(false);
  });
});
