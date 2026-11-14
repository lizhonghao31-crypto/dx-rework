import {it,expect,vi} from 'vitest';
import * as timing from '../../apps/api/src/production-platform/factory-batch-timing.js';
import * as craft from '../../apps/api/src/production-platform/fixed-craft-steps.js';
import {factorySlaEvidence} from '../../apps/api/src/production-platform/factory-sla-evidence.js';
it('keeps two special steps separate and retains every legacy-kind window instead of the last craft',async()=>{
 const steps=['first','second'].map((stepId,index)=>({stepId,craftKind:'special',specialCraft:{id:index?'BBBB':'AAAA'}}));
 const windows=steps.map((step,index)=>({key:step.stepId,kind:'process_logistics',stepRef:step.stepId,lineId:'red',enteredAt:`2027-01-0${index+1}T00:00:00Z`,completedAt:index?null:'2027-01-01T03:00:00Z',dueAt:`2027-01-0${index+1}T02:00:00Z`,warningAt:null,complete:!index,evidence:step.stepId,calendarRef:'continuous'}));
 const one=vi.spyOn(timing,'factoryBatchTiming').mockResolvedValue({preparationId:'TEST',windows,stepLedger:{steps:steps.map((step,index)=>({step,completion:[{complete:!index}]}))},ledger:{complete:false,canDispatch:false,totals:[{lineId:'red'}]}} as never);
 const two=vi.spyOn(craft,'fixedCraftSteps').mockResolvedValue(steps as never);
 try{
  const result=await factorySlaEvidence({query:vi.fn()} as never,'TEST');
  expect(result!.facts['bulk_special_AAAA:first']).toMatchObject({businessCompleted:true,completedAt:'2027-01-01T03:00:00.000Z'});
  expect(result!.facts['bulk_special_BBBB:second']).toMatchObject({businessCompleted:false});
  expect(result!.facts.bulk_special!.batchWindows).toHaveLength(2);
  expect(result!.facts.bulk_special!.businessCompleted).toBe(false);
 }finally{one.mockRestore();two.mockRestore();}
});
