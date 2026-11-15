import {describe,it,expect,vi} from 'vitest';
import {DevelopmentSubmissionReceiptSchema} from '@dx-rework/contracts/digital-development';
import {DigitalOrderCreateSchema} from '@dx-rework/contracts/digital-production';
import {developmentSubmissionResult,recoverDevelopmentSubmission,type PendingDevelopmentSubmission} from '../../apps/web/src/development-submit-recovery.js';
import {DigitalRequestError,type digitalRequest} from '../../apps/web/src/digital-production-api.js';

const sourceId='12345678-1111-4111-8111-123456789012',other='12345678-2222-4222-8222-123456789012';
const publish:PendingDevelopmentSubmission={operation:'publish',sourceId,key:'original-publish',body:{expectedVersion:2,patternOrder:{categoryId:other,priceVersion:1}}};
const confirm:PendingDevelopmentSubmission={operation:'confirm',sourceId,key:'original-confirm',body:DigitalOrderCreateSchema.parse({customerCode:'PD',productGroup:'男装',designStyleNo:'TEST-RECOVERY',orderDate:'2027-01-07',lines:[{formalPoNo:'TEST-PO',color:'黑',sizes:[{size:'M',quantity:10}]}]})};
describe('development original submission recovery',()=>{
 for(const command of [publish,confirm]){
  const completed=command.operation==='publish'?{status:'completed',operation:'publish',sourceId,documentVersion:3}:{status:'completed',operation:'confirm',sourceId,productionOrderId:other};
  it(`${command.operation}: missing receipt remains unknown and lookup sends no write`,async()=>{
   const request=vi.fn().mockResolvedValue({status:'unconfirmed'});
   expect(await recoverDevelopmentSubmission(command,false,request as typeof digitalRequest)).toEqual({status:'unconfirmed'});
   expect(request.mock.calls).toEqual([[`sources/${sourceId}/development/submission-receipt?operation=${command.operation}&key=${command.key}`]]);
  });
  it(`${command.operation}: a committed receipt recovers without replay even when replay is requested`,async()=>{
   const request=vi.fn().mockResolvedValue(completed);
   expect(await recoverDevelopmentSubmission(command,true,request as typeof digitalRequest)).toEqual(completed);
   expect(request).toHaveBeenCalledTimes(1);
  });
  it(`${command.operation}: explicit replay retains the captured exact body, version and key`,async()=>{
   const response=command.operation==='publish'?{sourceId,status:'published',version:3}:{sourceId,productionOrderId:other};
   const request=vi.fn().mockResolvedValueOnce({status:'unconfirmed'}).mockResolvedValueOnce(response);
   const before=structuredClone(command);expect(await recoverDevelopmentSubmission(command,true,request as typeof digitalRequest)).toEqual(completed);
   expect(command).toEqual(before);
   expect(request.mock.calls[1]).toEqual([`sources/${sourceId}/${command.operation==='publish'?'development/publish':'confirm'}`,'POST',before.body,before.key]);
  });
 }
 it.each([null,{}, {status:'completed',operation:'publish',sourceId:other,documentVersion:3}, {status:'completed',operation:'confirm',sourceId,productionOrderId:other}])('does not trust a malformed, wrong-source or wrong-operation read receipt: %j',async value=>{
  const request=vi.fn().mockResolvedValue(value);
  await expect(recoverDevelopmentSubmission(publish,true,request as typeof digitalRequest)).rejects.toMatchObject({resultUnknown:true,code:'INVALID_RESPONSE'});
  expect(request).toHaveBeenCalledTimes(1);
 });
 it('a denied lookup cannot trigger a replay or discard the original command',async()=>{
  const request=vi.fn().mockRejectedValue(new DigitalRequestError('无权读取',403));const before=structuredClone(publish);
  await expect(recoverDevelopmentSubmission(publish,true,request as typeof digitalRequest)).rejects.toMatchObject({status:403});
  expect(publish).toEqual(before);expect(request).toHaveBeenCalledTimes(1);
 });
 it('rejects a draft, incomplete or foreign write response as unknown instead of declaring publication/order completion',()=>{
  for(const result of [null,{}, {sourceId,status:'draft',version:2},{sourceId:other,status:'published',version:3}])expect(()=>developmentSubmissionResult(publish,result)).toThrow(DigitalRequestError);
  for(const result of [null,{}, {sourceId},{sourceId:other,productionOrderId:other}])expect(()=>developmentSubmissionResult(confirm,result)).toThrow(DigitalRequestError);
  expect(DevelopmentSubmissionReceiptSchema.safeParse({status:'failed'}).success).toBe(false);
 });
});
