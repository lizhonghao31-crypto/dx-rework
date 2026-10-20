import {describe,it,expect} from "vitest";
import {verificationRows} from "../../apps/api/src/production-platform/development-material-verification.js";
import {initialDevelopmentDocument} from "../../apps/web/src/digital-development-editing.js";
import {SaveMaterialVerificationSchema} from "@dx-rework/contracts/digital-development-execution";
const document=()=>{const doc=initialDevelopmentDocument();doc.materials[0]!.name="TEST主布";doc.materials[0]!.quantity="2";return doc;};
describe("clerk material verification boundaries",()=>{
 it("does not convert designer false or true into confirmation and excludes untouched template slots",()=>{
  const doc=document();expect(verificationRows(doc,[])).toMatchObject([{usage:"pending",physical:false}]);
  doc.materials[0]!.requiredThisRound=true;expect(verificationRows(doc,[])).toMatchObject([{usage:"pending"}]);
 });
 it("keeps unaffected evidence, invalidates changed dimensions and resets replaced material",()=>{
  const doc=document(),m=doc.materials[0]!,stored={materialId:m.materialId,usage:"use" as const,physical:true,quantity:true,color:true,specification:true,note:"",confirmedWith:"",basis:structuredClone(m),changedBy:"TEST文员",changedAt:"2026-10-20T00:00:00Z"};
  doc.instructions="新包装说明";expect(verificationRows(doc,[stored])[0]).toMatchObject({usage:"use",physical:true,quantity:true,invalidated:[]});
  m.quantity="3";expect(verificationRows(doc,[stored])[0]).toMatchObject({usage:"use",physical:true,quantity:false,color:true});
  m.name="换成另一种布";expect(verificationRows(doc,[stored])[0]).toMatchObject({usage:"pending",physical:false,quantity:false});
 });
 it("does not hide a previously confirmed material after its fields are emptied",()=>{
  const doc=initialDevelopmentDocument(),m=doc.materials[0]!;
  expect(verificationRows(doc,[{materialId:m.materialId,usage:"unused",physical:false,quantity:false,color:false,specification:false,note:"确认不用",confirmedWith:"设计师",basis:m,changedBy:"文员",changedAt:"2026-10-20"}])).toHaveLength(1);
 });
 it("rejects duplicate material identities in a batch",()=>{
  const id="00000000-0000-4000-8000-000000000001",entry={materialId:id,usage:"pending",physical:false,quantity:false,color:false,specification:false,note:"",confirmedWith:""};
  expect(SaveMaterialVerificationSchema.safeParse({taskId:id,expectedVersion:0,expectedDocumentVersion:1,entries:[entry,entry]}).success).toBe(false);
 });
});
