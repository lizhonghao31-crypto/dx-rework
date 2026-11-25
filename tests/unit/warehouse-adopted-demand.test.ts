import {describe,expect,it} from 'vitest';
import {warehouseAdoptedDemand} from '../../apps/api/src/production-platform/warehouse-adopted-demand.js';
import {warehouseMaterialBalance} from '../../apps/api/src/production-platform/warehouse-material-balance.js';

const evidence={capturedInstructionVersion:3,activeInstructionVersion:3,instructionMaterialId:'formal-a',boundInstructionMaterialId:'formal-a',
 sourceMaterialId:'source-a',artifactMaterialId:'source-a',lineId:null,unit:'米',perPiece:{unit:'米',quantity:'1.25'},
 adoptedLines:[{lineId:'blue',pieces:300},{lineId:'green',pieces:100}]};

describe('warehouse demand uses the adopted original material and PO range',()=>{
 it('uses each original PO once for shared material and only the requested exact PO otherwise',()=>{
  const productionRequired=warehouseAdoptedDemand(evidence);
  expect(productionRequired).toEqual({unit:'米',quantity:'500'});
  expect(warehouseAdoptedDemand({...evidence,lineId:'green'})).toEqual({unit:'米',quantity:'125'});
  expect(warehouseAdoptedDemand({...evidence,lineId:'new-unadopted-po'})).toBeNull();
  expect(warehouseMaterialBalance({unit:'米',productionRequired,invested:{unit:'米',quantity:'520'},received:{unit:'米',quantity:'500'},
   usableAfterOccupancy:{unit:'米',quantity:'500'},dispatchRequired:productionRequired,dispatched:{unit:'米',quantity:'300'}}))
   .toMatchObject({procurementRemaining:'20',productionShortage:'0',dispatchRemaining:'200'});
 });
 it('does not substitute a current version, the same-named material, an ambiguous PO or another unit',()=>{
  for(const correction of [{activeInstructionVersion:4},{boundInstructionMaterialId:'like-a'},
   {artifactMaterialId:'other-material'},{lineId:'missing-po'},{perPiece:{unit:'码',quantity:'1.25'}},
   {adoptedLines:[...evidence.adoptedLines,evidence.adoptedLines[0]!]}])
   expect(warehouseAdoptedDemand({...evidence,...correction})).toBeNull();
 });
 it('does precise decimal multiplication without converting unit or using a stock fall-back',()=>{
  expect(warehouseAdoptedDemand({...evidence,perPiece:{unit:'米',quantity:'0.0001'},adoptedLines:[{lineId:'blue',pieces:3}]}))
   .toEqual({quantity:'0.0003',unit:'米'});
  expect(warehouseMaterialBalance({unit:'米',productionRequired:warehouseAdoptedDemand(evidence),invested:null,
   received:{unit:'米',quantity:'500'},usableAfterOccupancy:null,dispatchRequired:null,dispatched:null}).productionShortage).toBeNull();
 });
});
