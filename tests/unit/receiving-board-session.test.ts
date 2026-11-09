// @vitest-environment jsdom
import {act,createElement,Fragment} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {useReceivingBoardEditSession} from "../../apps/web/src/receiving-board-edit-session.js";
import {useReceivingBoardRead} from "../../apps/web/src/receiving-board-read.js";
import type {BoardRow} from "../../apps/web/src/receiving-board-types.js";
vi.mock("../../apps/web/src/auth.js",()=>({verifySession:vi.fn(async()=>"denied")}));
const id="00000000-0000-4000-8000-000000000001",other="00000000-0000-4000-8000-000000000002",at="2026-11-08T00:00:00Z";
const row:BoardRow={receivingBatchId:id,styleNo:"TEST original",documentQuantity:10,attachments:[],priorActualQuantity:0,actualQuantity:9,defectiveQuantity:0,currentActualQuantity:9,currentDefectiveQuantity:0,cumulativeActualQuantity:9,differenceQuantity:-1,packingRevisionId:null,packingQuantity:null,packingDifferenceQuantity:null,packingRecordedBy:null,packingRecordedAt:null,actualCutCount:10,cuttingRecordedBy:"TEST",cuttingRecordedAt:at,receivingDifferenceResolution:null,packingDifferenceResolution:null,receiptCount:1,receivingHistory:[],lastReceivedAt:at,lastReceiverName:"TEST",reworkOrderId:null,reworkStatus:null,version:1,rootCorrectable:true,rootDeletable:true,rootMutable:true};
const board=(styleNo:string)=>({date:"2026-11-08",startDate:"2026-11-08",endDate:"2026-11-08",mode:"search",status:"all",rows:[{...row,styleNo}],kpis:{orderCount:1,receivedQuantity:9,abnormalOrderCount:1,differenceQuantity:1,differenceRate:10},page:1,pageSize:15,totalCount:1,totalPages:1});
let host:HTMLDivElement,root:Root|null,current:ReturnType<typeof useReceivingBoardEditSession>,read:ReturnType<typeof useReceivingBoardRead>;
const refresh=vi.fn(),revoke=vi.fn(),createUrl=vi.fn();
let createDescriptor:PropertyDescriptor|undefined,revokeDescriptor:PropertyDescriptor|undefined;
function EditHarness(){current=useReceivingBoardEditSession(refresh);return createElement(Fragment,null,current.recoveryActions);}
function ReadHarness({target}:{target:string}){read=useReceivingBoardRead(target,false);return null;}
beforeEach(()=>{
 vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);host=document.createElement("div");document.body.append(host);root=createRoot(host);refresh.mockClear();revoke.mockClear();createUrl.mockReset().mockImplementation(()=>"blob:TEST-"+createUrl.mock.calls.length);
 createDescriptor=Object.getOwnPropertyDescriptor(URL,"createObjectURL");revokeDescriptor=Object.getOwnPropertyDescriptor(URL,"revokeObjectURL");Object.defineProperty(URL,"createObjectURL",{configurable:true,value:createUrl});Object.defineProperty(URL,"revokeObjectURL",{configurable:true,value:revoke});
});
afterEach(async()=>{
 if(root)await act(async()=>root!.unmount());host.remove();vi.unstubAllGlobals();
 for(const[name,descriptor]of [["createObjectURL",createDescriptor],["revokeObjectURL",revokeDescriptor]] as const){if(descriptor)Object.defineProperty(URL,name,descriptor);else Reflect.deleteProperty(URL,name);}
});
it("keeps one original unknown command after closing its dialog and refuses a different row before exact replay",async()=>{
 const fetch=vi.fn().mockRejectedValueOnce(new TypeError("TEST lost receipt")).mockResolvedValue(Response.json({receivingBatchId:id,packingRevisionId:other,packingQuantity:9,recordedBy:id,recordedAt:at}));vi.stubGlobal("fetch",fetch);
 await act(async()=>root!.render(createElement(EditHarness)));await act(async()=>current.openPacking(row));await act(async()=>current.setPackingQuantity("9"));await act(async()=>current.submitPacking());
 expect(current.mutationUnknown).toBe(true);const original=fetch.mock.calls[0]![1] as RequestInit;
 await act(async()=>{current.setPackingQuantity("77");current.setPackingEditing(null);});await act(async()=>current.openEdit({...row,receivingBatchId:other}));
 expect(current.editing).toBeNull();expect(current.boardMutation.current.hasUnknown()).toBe(true);expect(fetch).toHaveBeenCalledTimes(1);
 const retry=[...host.querySelectorAll("button")].find(button=>button.textContent==="使用原内容核对提交结果")!;
 await act(async()=>{retry.click();});expect(fetch).toHaveBeenCalledTimes(2);const replay=fetch.mock.calls[1]![1] as RequestInit;
 expect(replay.body).toBe(original.body);expect(new Headers(replay.headers).get("idempotency-key")).toBe(new Headers(original.headers).get("idempotency-key"));expect(current.mutationUnknown).toBe(false);expect(refresh).toHaveBeenCalledOnce();
});
it("releases only its selected difference image URLs on removal, close and unmount",async()=>{
 await act(async()=>root!.render(createElement(EditHarness)));await act(async()=>current.openDifference(row,"receiving"));
 const files=[new File(["TEST"],"one.png",{type:"image/png"}),new File(["TEST"],"two.png",{type:"image/png"})];
 await act(async()=>current.selectDifferenceImages(files as unknown as FileList));expect(current.differenceImages).toHaveLength(2);
 await act(async()=>current.removeDifferenceImage(current.differenceImages[0]!));expect(revoke.mock.calls.map(args=>args[0])).toEqual(["blob:TEST-1"]);
 await act(async()=>current.closeDifference());expect(revoke.mock.calls.map(args=>args[0])).toEqual(["blob:TEST-1","blob:TEST-2"]);
 await act(async()=>current.openDifference(row,"receiving"));await act(async()=>current.selectDifferenceImages([files[0]!] as unknown as FileList));await act(async()=>root!.unmount());root=null;
 expect(revoke.mock.calls.map(args=>args[0])).toEqual(["blob:TEST-1","blob:TEST-2","blob:TEST-3"]);
});
it("ignores stale read success and failure when the exact batch changes A to B to A",async()=>{
 const pending:Array<(response:Response)=>void>=[];vi.stubGlobal("fetch",vi.fn(()=>new Promise<Response>(resolve=>pending.push(resolve))));
 await act(async()=>root!.render(createElement(ReadHarness,{target:id})));await act(async()=>root!.render(createElement(ReadHarness,{target:other})));await act(async()=>root!.render(createElement(ReadHarness,{target:id})));expect(pending).toHaveLength(3);
 await act(async()=>pending[2]!(Response.json(board("TEST latest A"))));await act(async()=>pending[0]!(Response.json(board("TEST old A"))));await act(async()=>pending[1]!(Response.json({error:{message:"TEST old failure"}},{status:503})));
 expect(read.data?.rows[0]?.styleNo).toBe("TEST latest A");expect(read.readFailed).toBe(false);expect(read.pageLoading).toBe(false);expect(read.message).toBe("");
});
