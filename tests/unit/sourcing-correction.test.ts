import { describe, expect, it } from "vitest";
import { CorrectSourcingCaseSchema, CreateSourcingCaseSchema, cumulativeSourcingTiming } from "@dx-rework/contracts";

const facts = { gender:"男装", styleName:"长裤", estimatedCutPieceSendDate:"2026-09-20",deliveryDate:"2026-09-30",lineItems:[{styleNo:"A001",color:"黑",quantity:100}],attachmentIds:["00000000-0000-4000-8000-000000000001"] };
describe("sourcing correction boundaries",()=>{
  it("rejects reversed dates for creation and correction, accepts the same day",()=>{
    expect(CreateSourcingCaseSchema.safeParse({...facts,daxingUnitPrice:"6.5"}).success).toBe(true);
    expect(CreateSourcingCaseSchema.safeParse({...facts,daxingUnitPrice:"6.5",estimatedCutPieceSendDate:"2026-10-01"}).success).toBe(false);
    expect(CorrectSourcingCaseSchema.safeParse({...facts,expectedVersion:2,reason:"更正日期",estimatedCutPieceSendDate:"2026-10-01"}).success).toBe(false);
    expect(CorrectSourcingCaseSchema.safeParse({...facts,expectedVersion:2,reason:"更正日期",estimatedCutPieceSendDate:"2026-09-30"}).success).toBe(true);
    expect(CorrectSourcingCaseSchema.safeParse({...facts,expectedVersion:2,reason:"更正",daxingUnitPrice:"1"}).success).toBe(false);
  });
  it("accumulates repeated node visits and correction time without resetting order age",()=>{
    const at=(day:number)=>`2026-09-${String(day).padStart(2,"0")}T00:00:00.000Z`;
    const history=[
      {to:"pending_ie_quote",enteredAt:at(1),leftAt:at(3),changesNode:true},
      {to:"pending_management_decision",enteredAt:at(3),leftAt:at(4),changesNode:true},
      {to:"pending_merchandiser_correction",enteredAt:at(4),leftAt:at(5),changesNode:true},
      {to:"pending_ie_quote",enteredAt:at(5),leftAt:at(6),changesNode:true},
      {to:"pending_merchandiser_correction",enteredAt:at(6),leftAt:at(7),changesNode:true},
      {to:"pending_ie_quote",enteredAt:at(7),leftAt:null,changesNode:true},
    ];
    const result=cumulativeSourcingTiming(history,at(1),at(8));
    expect(result.totalSeconds).toBe(7*86400);
    expect(result.nodeSeconds.pending_ie_quote).toBe(4*86400);
    expect(result.nodeSeconds.pending_merchandiser_correction).toBe(2*86400);
    expect(Object.values(result.nodeSeconds).reduce((a,b)=>a+b,0)).toBe(result.totalSeconds);
  });
});
