import {describe,expect,it} from 'vitest';
import {preorderInvestmentApplicability} from '../../apps/api/src/production-platform/preorder-investment-applicability.js';
import {preorderApplicabilityProofMatches,preorderDemandInUnit,recoverPreorderHandedMaterial} from '../../apps/api/src/production-platform/preorder-investment-applicability.js';
import {originalPreorderDemandBalance} from '../../apps/api/src/production-platform/preorder-investment-evidence.js';
import {createHash} from 'node:crypto';

const original={materialId:'material-X',supplierId:'supplier-1',category:'主布',name:'原棉布',color:'黑',
 unit:'米',requested:'520.00',poLineIds:['po-2','po-1'],specification:'',width:'',weight:'200',composition:'棉'};

describe('Acceptance R4 preorder investment applicability preparation',()=>{
 it('retains exact original 520-meter demand and requires same-material proof only for descriptive fills',()=>{
  expect(preorderInvestmentApplicability(original,{...original,requested:'520',poLineIds:['po-1','po-2']},false)).toEqual({state:'unchanged'});
  const edited={...original,specification:'40支',width:'150'};
  expect(preorderInvestmentApplicability(original,edited,false)).toEqual({state:'needs_same_material_proof',filled:['specification','width']});
  expect(preorderInvestmentApplicability(original,edited,true)).toEqual({state:'descriptive_fill',filled:['specification','width']});
 });
 it('distinguishes exact requested changes from the already physical amount',()=>{
  expect(preorderInvestmentApplicability(original,{...original,requested:'520.0000001'},false)).toMatchObject({state:'quantity_amendment',direction:'increase'});
  expect(preorderInvestmentApplicability(original,{...original,requested:'490'},false)).toMatchObject({state:'quantity_amendment',direction:'decrease'});
 });
 it('calculates only the unpaid demand difference and keeps actual excess without inferring a legacy unit',()=>{
  const physical=[{quantity:500,unit:'米'},{quantity:20,unit:'米'}];
  expect(originalPreorderDemandBalance('580','米',physical)).toEqual({requested:'580',originallyRecorded:'520',remaining:'60',unit:'米'});
  expect(originalPreorderDemandBalance('490','米',physical)).toEqual({requested:'490',originallyRecorded:'520',remaining:'0',unit:'米'});
  expect(originalPreorderDemandBalance('580','米',[...physical,{quantity:30,unit:'码'}])).toBeNull();
  expect(preorderDemandInUnit('520','米')).toBeNull();
  expect(preorderDemandInUnit('520米','米')).toBe('520');
  expect(preorderDemandInUnit('520','米','米')).toBe('520');
  expect(preorderDemandInUnit('520码','米','米')).toBeNull();
 });
 it('does not inherit replaced materials, nonempty specification changes or ambiguous units and PO scope',()=>{
  const filled={...original,specification:'40支'};
  for(const changed of [{supplierId:'new-supplier'},{materialId:'new-id'},{specification:'80支'},{color:'白'}])
   expect(preorderInvestmentApplicability(filled,{...filled,...changed},true)).toEqual({state:'replacement'});
  for(const changed of [{supplierId:null},{unit:'码'},{poLineIds:['po-3']},{poLineIds:null},{requested:'unknown'}])
   expect(preorderInvestmentApplicability(filled,{...filled,...changed},true)).toEqual({state:'needs_identity'});
 });
 it('proves a blank old technical field from the original complete hash, never from a wildcard',()=>{
  const stored={materialId:'material-X',category:'主布',name:'原棉布',quantity:'520',color:'黑',specification:'',supplier:'原供方',supplierId:'supplier-1'};
  const current={...stored,specification:'40支',width:'150',weight:'200',composition:'棉'};
  const fingerprint=(emptyOrOldWidth:string)=>createHash('sha256').update(JSON.stringify([
   stored.materialId,stored.category,stored.name,stored.quantity,stored.color,'',stored.supplier,emptyOrOldWidth,'200','棉'])).digest('hex');
  expect(recoverPreorderHandedMaterial(stored,current,fingerprint(''))).toMatchObject({width:'',weight:'200',composition:'棉',specification:''});
  expect(recoverPreorderHandedMaterial(stored,current,fingerprint('160'))).toBeNull();
 });
 it('cannot reuse a confirmation for corrected investment, another source version or unwitnessed material',()=>{
  const same={sourceId:'source-1',roundNumber:1,sourceVersion:8,materialId:'material-X',handover:{recordId:'original-H',version:1},
   investment:{recordId:'original-I',version:2},beforeFingerprint:'old',afterFingerprint:'new'};
  const proof={...same,actorId:'original-merch',confirmedAt:'2027-02-02T02:02:02.000Z',sameMaterialEvidenceIds:['actual-receipt']};
  expect(preorderApplicabilityProofMatches(proof,same)).toBe(true);
  expect(preorderApplicabilityProofMatches(proof,{...same,sourceVersion:9})).toBe(false);
  expect(preorderApplicabilityProofMatches(proof,{...same,investment:{...same.investment,version:3}})).toBe(false);
  expect(preorderApplicabilityProofMatches({...proof,sameMaterialEvidenceIds:[]},same)).toBe(false);
 });
});
