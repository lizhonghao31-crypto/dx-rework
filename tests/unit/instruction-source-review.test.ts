import {describe,it,expect} from "vitest";
import {randomUUID} from "node:crypto";
import {initialInstruction,changedInstructionSourceGroups,applyInstructionSourceReview,ReviewInstructionSourceSchema} from "@dx-rework/contracts/production-instruction";
describe("instruction source decisions",()=>{
 it("compares source values rather than regenerated row IDs or unrelated remarks",()=>{
  const before={...initialInstruction(),measurements:[{id:randomUUID(),name:"胸围",tolerance:"",method:"",values:["20"]}],sizes:["M"]};
  const after={...before,remarks:"本单备注",measurements:[{...before.measurements[0]!,id:randomUUID()}]};
  expect(changedInstructionSourceGroups(before,after)).toEqual([]);
  expect(changedInstructionSourceGroups(before,{...after,comments:"新技术",measurements:[{...after.measurements[0]!,values:["21"]}]})).toEqual(["comments","measurements"]);
 });
 it("adopts only explicit groups, retains bulk differences and appends images without deleting originals",()=>{
  const oldImage={attachmentId:randomUUID(),kind:"款图" as const,description:"本单专用说明"},newImage={attachmentId:randomUUID(),kind:"其它工艺" as const,description:"新图"};
  const current={...initialInstruction(),comments:"本单大货差异",remarks:"人工备注",process:"人工工艺",images:[oldImage]};
  const proposed={...initialInstruction(),comments:"开发新技术",process:"开发新工艺",images:[{...oldImage,description:""},newImage]};
  const result=applyInstructionSourceReview(current,proposed,[{group:"comments",action:"retain"},{group:"craft",action:"adopt"},{group:"images",action:"adopt"}]);
  expect(result.comments).toBe("本单大货差异");expect(result.remarks).toBe("人工备注");expect(result.process).toBe("开发新工艺");expect(result.images).toEqual([oldImage,newImage]);expect(current.images).toEqual([oldImage]);
  expect(()=>applyInstructionSourceReview(current,{...proposed,images:Array.from({length:60},()=>({...newImage,attachmentId:randomUUID()}))},[{group:"images",action:"adopt"}])).toThrow();
 });
 it("rejects ambiguous duplicate decisions and unknown scopes",()=>{
  const value={expectedVersion:1,orderVersion:1,sourceRound:2,sourceVersion:1,document:initialInstruction(),decisions:[{group:"comments",action:"retain"}]};
  expect(ReviewInstructionSourceSchema.safeParse(value).success).toBe(true);
  expect(ReviewInstructionSourceSchema.safeParse({...value,decisions:[...value.decisions,...value.decisions]}).success).toBe(false);
  expect(ReviewInstructionSourceSchema.safeParse({...value,decisions:[{group:"price",action:"adopt"}]}).success).toBe(false);
  expect(ReviewInstructionSourceSchema.safeParse({...value,sourceRound:0}).success).toBe(false);
 });
 it("adopts measurements while keeping bulk tolerances, methods and added measurement rows",()=>{
  const row={id:randomUUID(),name:"胸围",tolerance:"1/4",method:"大货量法",values:["20"]};
  const custom={id:randomUUID(),name:"自定义腰围",tolerance:"",method:"自定义",values:["18"]};
  const current={...initialInstruction(),sizes:["M"],measurements:[row,custom]},proposed={...initialInstruction(),sizes:["M","L"],measurements:[{...row,id:randomUUID(),tolerance:"",method:"",values:["21","22"]}]};
  const reviewed=applyInstructionSourceReview(current,proposed,[{group:"measurements",action:"adopt"}]);
  expect(reviewed.measurements).toEqual([{...row,values:["21","22"]},{...custom,values:["18",""]}]);expect(reviewed.sizes).toEqual(["M","L"]);
 });
});
