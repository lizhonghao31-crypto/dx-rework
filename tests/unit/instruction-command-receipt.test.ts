import { describe, expect, it } from 'vitest';
import { initialInstruction, type InstructionSheet } from '@dx-rework/contracts/production-instruction';
import { instructionCommandMatches } from '../../apps/web/src/command-receipt-content.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const sheet = () => ({ order:{ productionOrderId:id(1), version:3, lines:[] }, version:4,
  document:initialInstruction(), sourceRound:1, publishedVersion:3, versions:[3], dateRequests:[],
} as unknown as InstructionSheet);
describe('instruction acknowledgements belong to the frozen action', () => {
  it('accepts normalized save, rejects stale version, wrong document, order or source', () => {
    const before=sheet(), body={expectedVersion:4,orderVersion:3,sourceRound:1,document:{...before.document,styleName:'  TEST新款名  '}};
    const good={...before,version:5,document:{...body.document,styleName:'TEST新款名'}};
    expect(instructionCommandMatches(good,before,'','PUT',body)).toBe(true);
    for(const bad of [before,{...good,document:before.document},{...good,sourceRound:2},{...good,order:{...good.order,productionOrderId:id(2)}}])
      expect(instructionCommandMatches(bad,before,'','PUT',body)).toBe(false);
  });
  it('publish must acknowledge this version, published fact and original document', () => {
    const before=sheet(),body={expectedVersion:4,orderVersion:3},good={...before,publishedVersion:4,versions:[4,3]};
    expect(instructionCommandMatches(good,before,'/publish','POST',body)).toBe(true);
    for(const bad of [before,{...good,versions:[3]},{...good,document:{...before.document,remarks:'别的提交'}}])
      expect(instructionCommandMatches(bad,before,'/publish','POST',body)).toBe(false);
  });
  it('source review checks original comparison, actual adopted values and decision receipt', () => {
    const before=sheet();before.sourceComparison={sourceRound:2,sourceVersion:9,before:before.document,proposed:{...before.document,composition:'TEST新成分'},groups:['composition']};
    const body={expectedVersion:4,orderVersion:3,sourceRound:2,sourceVersion:9,document:before.document,decisions:[{group:'composition',action:'adopt'}]};
    const good={...before,version:5,sourceRound:2,document:{...before.document,composition:'TEST新成分'},sourceReview:{sourceRound:2,sourceVersion:9,instructionVersion:5,decisions:body.decisions,reviewedAt:'2026-10-20T00:00:00Z',reviewedBy:'TEST'}} as InstructionSheet;
    expect(instructionCommandMatches(good,before,'/source-review','POST',body)).toBe(true);
    for(const bad of [before,{...good,document:before.document},{...good,sourceReview:{...good.sourceReview!,sourceVersion:8}},{...good,sourceReview:{...good.sourceReview!,decisions:[]}}])
      expect(instructionCommandMatches(bad,before,'/source-review','POST',body)).toBe(false);
  });
  it('date request needs a new matching request, not an old identical history row', () => {
    const before=sheet(),body={orderVersion:3,reason:' TEST日期 ',changes:[{lineId:id(3),expectedVersion:2,date:'2099-01-01'}]};
    const request={requestId:id(5),source:'po',reason:'TEST日期',status:'待批准',changes:body.changes} as InstructionSheet['dateRequests'][number];
    const good={...before,dateRequests:[request]};
    expect(instructionCommandMatches(good,before,'/date-requests','POST',body)).toBe(true);
    expect(instructionCommandMatches(before,before,'/date-requests','POST',body)).toBe(false);
    expect(instructionCommandMatches(good,good,'/date-requests','POST',body)).toBe(false);
    expect(instructionCommandMatches({...good,dateRequests:[{...request,reason:'其他原因'}]},before,'/date-requests','POST',body)).toBe(false);
  });
  it('date decisions check the original request, decision and approved line state', () => {
    const before=sheet(),request={requestId:id(5),reason:'TEST日期',status:'待批准',changes:[{lineId:id(3),expectedVersion:2,date:'2099-01-01'}]} as InstructionSheet['dateRequests'][number];
    before.dateRequests=[request];const good={...before,dateRequests:[{...request,status:'已批准',decidedAt:'2026-10-20T00:00:00Z'}],customerPoDates:[{lineId:id(3),version:3,date:'2099-01-01'}]} as InstructionSheet;
    expect(instructionCommandMatches(good,before,`/date-requests/${id(5)}/decision`,'POST',{approved:true})).toBe(true);
    for(const bad of [before,{...good,customerPoDates:[]},{...good,dateRequests:[{...good.dateRequests[0]!,status:'已驳回'}]}])
      expect(instructionCommandMatches(bad,before,`/date-requests/${id(5)}/decision`,'POST',{approved:true})).toBe(false);
    expect(instructionCommandMatches({...good,dateRequests:[{...good.dateRequests[0]!,status:'已驳回'}]},before,`/date-requests/${id(5)}/decision`,'POST',{approved:false})).toBe(true);
  });
  it('unrecognized action or malformed response cannot acknowledge a write', () => {
    expect(instructionCommandMatches(sheet(),sheet(),'/unknown','POST',{})).toBe(false);
    expect(instructionCommandMatches({...sheet(),dateRequests:null} as unknown as InstructionSheet,sheet(),'/date-requests','POST',{})).toBe(false);
  });
});
