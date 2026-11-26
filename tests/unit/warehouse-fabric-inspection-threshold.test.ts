import {describe,expect,it} from 'vitest';
import {warehouseFabricInspectionThreshold} from '../../apps/api/src/production-platform/warehouse-material-balance.js';
import {warehouseFabricInspectionEligibility} from '../../apps/api/src/production-platform/warehouse-fabric-inspection-eligibility.js';

const meters=(quantity:string)=>({quantity,unit:'米'});
describe('Acceptance R5 exact purchase receipt threshold',()=>{
 it.each([['500','449',false],['500','450',true],['500','490',true],['500','500',true],['520','450',false],
  ['520','468',true],['500.000001','450.000000',false],['500.000001','450.000001',true],['500','0',false]] as const)(
  'uses actual purchase expectation %s and actual received %s without percentage rounding',(expected,received,eligible)=>{
   expect(warehouseFabricInspectionThreshold('米',meters(expected),meters(received))).toBe(eligible);
  });
 it('does not turn missing, zero purchase, invalid quantity or unproved mixed units into clearance',()=>{
  expect(warehouseFabricInspectionThreshold('米',meters('0'),meters('500'))).toBeNull();
  expect(warehouseFabricInspectionThreshold('米',null,meters('500'))).toBeNull();
  expect(warehouseFabricInspectionThreshold('米',meters('500'),null)).toBeNull();
  expect(warehouseFabricInspectionThreshold('米',meters('500'),meters('unknown'))).toBeNull();
  expect(warehouseFabricInspectionThreshold('米',meters('500'),{quantity:'500',unit:'码'})).toBeNull();
 });
 it('uses each required material/PO, does not offset shortfall and excludes lots after the actual inspection',()=>{
  const prior='2026-11-26T08:00:00.000Z',cutoff='2026-11-26T09:00:00.000Z',after='2026-11-26T10:00:00.000Z';
  const a={materialId:'fabric-A',name:'黑布',poLineIds:['po-1','po-2']};
  const b={materialId:'fabric-B',name:'白布',poLineIds:['po-1','po-2']};
  const lot=(quantity:string,version=1,occurredAt=prior)=>({quantity:meters(quantity),occurredAt,ref:{recordId:'receipt',version}});
  const row=(materialId:string,name:string,lineId:string|null,lots:ReturnType<typeof lot>[],expected='500')=>({
   materialId,name,lineId,purchase:{invested:meters(expected),investedAt:prior,original:{recordId:'I',version:1},handover:{recordId:'H',version:1}},
   balance:{unit:'米',procurementRemaining:null,excessReceived:null,productionShortage:null,dispatchRemaining:null},
   received:meters('999'),activeBatches:lots,
  });
  const a1=row(a.materialId,a.name,'po-1',[lot('449'),lot('1',2,after)]),a2=row(a.materialId,a.name,'po-2',[lot('600')]),
   b1=row(b.materialId,b.name,null,[lot('520')],'520');
  expect(warehouseFabricInspectionEligibility([a,b],[a1,a2,b1],cutoff)).toMatchObject({eligible:false,reasons:['黑布：本范围实际实收未达到采购应收90%']});
  expect(warehouseFabricInspectionEligibility([a,b],[a1,a2,b1],after)).toEqual({eligible:true,reasons:[],firstReceiptAt:prior});
  expect(warehouseFabricInspectionEligibility([a,b],[a2,b1],after)).toMatchObject({eligible:false});
  expect(warehouseFabricInspectionEligibility([a,b],[a1,a2,{...b1,received:null}],after)).toMatchObject({eligible:false});
 });
});
