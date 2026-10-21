import {describe,it,expect} from 'vitest';
import {contractInformationRefreshReceipt} from '../../apps/web/src/contract-information-refresh.js';
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,now='2026-10-21T00:00:00.000Z',expected={caseId:id(1),documentId:id(2),fingerprint:'a'.repeat(64),key:'TEST-original'};
const item={sourcingContractDocumentId:id(3),sourcingApprovalSnapshotId:id(4),contractNumber:'TEST-NEW',contractVersion:3,templateVersion:1,status:'ready',missingFields:[],snapshotFingerprint:'b'.repeat(64),pdfAttachmentId:id(5),pdfSha256:'c'.repeat(64),failureReason:null,preparedAt:now,generatedAt:now,canSupplement:false};
const refreshReceipt={sourcingCaseId:expected.caseId,previousDocumentId:expected.documentId,documentId:item.sourcingContractDocumentId,informationFingerprint:expected.fingerprint,idempotencyKey:expected.key,previousVersion:2,contractVersion:3,sourcingApprovalSnapshotId:item.sourcingApprovalSnapshotId};
describe('P12 original contract information command receipt',()=>{
 it('accepts the actual new document and its completed original command',()=>expect(contractInformationRefreshReceipt({item,refreshReceipt},expected).item).toEqual(item));
 it.each([
  {item}, {item:null,refreshReceipt},
  {item:{...item,sourcingContractDocumentId:expected.documentId},refreshReceipt:{...refreshReceipt,documentId:expected.documentId}},
  {item,refreshReceipt:{...refreshReceipt,sourcingCaseId:id(9)}},
  {item,refreshReceipt:{...refreshReceipt,previousDocumentId:id(9)}},
  {item,refreshReceipt:{...refreshReceipt,informationFingerprint:'d'.repeat(64)}},
  {item,refreshReceipt:{...refreshReceipt,idempotencyKey:'TEST-other'}},
  {item:{...item,contractVersion:4},refreshReceipt},
  {item,refreshReceipt:{...refreshReceipt,previousVersion:1}},
  {item,refreshReceipt:{...refreshReceipt,sourcingApprovalSnapshotId:id(9)}},
 ])('refuses an old, other-order, mismatched version or unrelated receipt',value=>expect(()=>contractInformationRefreshReceipt(value,expected)).toThrow());
});
