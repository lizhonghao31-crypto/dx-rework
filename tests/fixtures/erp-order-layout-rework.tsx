// Include the application static CSS cascade without mounting unrelated pages.
import "../../apps/web/src/App.js";
// Offline synthetic detail-page fixture: every fetch is intercepted, no business API.
import { createRoot } from "react-dom/client";
import { ReworkDetailPage, type ReworkBusinessDetail } from "../../apps/web/src/rework-detail-page.js";
import "../../packages/ui/src/tokens.css";
import "../../packages/ui/src/components.css";
import "../../apps/web/src/styles.css";
import "../../apps/web/src/workflow-shell.css";
import "../../apps/web/src/workflow-state-visual.css";
import "../../apps/web/src/ui-polish.css";

const id = (suffix: string) => `00000000-0000-4000-8000-${suffix.padStart(12, "0")}`;
const params = new URLSearchParams(location.search);
const stage = params.get("stage") ?? "N04";
const role = params.get("role") ?? "root";
const readOnly = params.get("readonly") === "1";
const processId = id("1"), orderId = id("2"), userId = id("3");
const capabilities = role === "tail" ? ["submission:audit", "work:assign"] : role === "mixed" ? ["process:review", "submission:audit"] : ["process:review"];
const user = { id: userId, displayName: "TEST IE", isRoot: role === "root", businessRoles: role === "mixed" ? ["ie_reviewer", "tail_supervisor"] : [role === "tail" ? "tail_supervisor" : "ie_reviewer"], capabilities, effectiveWriteCapabilities: readOnly ? [] : capabilities, readOnlyModules: readOnly ? ["rework"] : [] };
const canRecord = role !== "tail" && stage !== "N06";
const tailRequired = params.get("tail") === "1";
const entries = [{ entryId: id("4"), configurationItemId: processId, processName: "TEST 工序", quantity: 3, note: "原预核", recordedBy: "TEST IE", recordedAt: "2026-10-11T00:00:00.000Z" }];
const detail: ReworkBusinessDetail = {
  reworkOrderId: orderId, reworkNo: "RW-TEST", reworkKind: params.get("kind") === "finishing" ? "inhouse_finishing" : "qc_rework", status: stage === "N04" ? "in_progress" : stage === "N06" ? "pending_final_quantity_ie_review" : "pending_order_review", version: 7,
  styleNo: "TEST-DX-2026-秋季外套-01", customerSupplyCode: null, factoryStyleNo: null, orderNo: "TEST-ONLY", orderQuantity: 10, sourceReceivingActualQuantity: 10,
  iePrecounts: { canRecord, processes: [{ configurationItemId: processId, processName: "TEST 工序" }], entries },
  defectiveQuantity: { receiving: 2, receivingLinked: true, tail: 0, total: 2, canAddTail: false, tailEntries: [] },
  supplyContext: { washingSupplierName: null, embroiderySupplierName: null, fabricSupplierName: null, embroideryMerchandiserName: null },
  merchandiser: { userId: id("15"), displayName: "TEST 跟单张三" }, processingFactory: { type: "own_factory", supplierId: null, displayName: "TEST 合成服装加工合作工厂（秋季承接车间）" }, reworkReason: "合成原因：袖口与下摆按原要求返修，保留原历史及数量。", reworkProcess: "袖口补线、下摆修整", problemPart: null, problemDescription: null, reworkQuantity: 10,
  tailInspectionRequired: tailRequired, canReadBusinessDetails: true, singlePieceReworkTotal: 1, inspectionReport: null,
  createdBy: { userId: id("5"), displayName: "TEST QC" }, processConfigurationCreatedBy: null,
  createdAt: "2026-10-11T00:00:00.000Z", updatedAt: "2026-10-11T00:00:00.000Z", submittedAt: null, cancelledAt: null, cancelReason: null,
  settlementStatus: "not_required", wageSettlementStatus: "not_required", unsettledWagePeriods: [], attachments: Array.from({length:6},(_,i)=>({attachmentId:id(String(91+i)),filename:`TEST-合成款式原始长文件名-秋季外套-${i+1}.png`,mimeType:"image/png",entityType:"rework_order"})), workflowHistory: [],
};
const overview = {
  reworkOrderId: orderId, reworkStatus: detail.status, orderVersion: 7,
  canReview: ["tail", "root", "mixed", "delegated-ie"].includes(role), canIeReview: stage === "N06" && role !== "tail", canAdjustQuantity: false, canConfirmQuantity: false,
  canReviewQuantityIncrease: false, unifiedExecutionRequired: false, tailInspectionRequired: tailRequired,
  processes: [{ configurationItemId: processId, processName: "TEST 工序", pricingUnit: "piece", plannedQuantity: 10, originalCompletedQuantity: 10, completedQuantity: 10, originalTailCheckedQuantity: tailRequired ? 10 : 0, tailCheckedQuantity: tailRequired ? 10 : 0, countGap: 0, complete: true, finalUnitPrice: 1 }],
  reports: [], adjustments: [], temporaryWorkers: [], reviewId: null, finalConfirmation: null,
};

const requests: {path:string;method:string;body:unknown}[]=[];
Object.assign(window,{orderLayoutFixture:{requests,family:"rework",detail}});
const entry={id:id("81"),label:detail.reworkKind==="inhouse_finishing"?"发起本厂做尾":"发起返工",at:detail.createdAt,actor:"TEST QC"};
const history={reworkKind:detail.reworkKind,orderId,node:"initiation",entry,versions:[entry],inspectionReport:null,sections:[],notices:[],attachments:detail.attachments.map(({attachmentId,filename,mimeType})=>({attachmentId,filename,mimeType})),fields:Object.entries({"款号":detail.styleNo,"加工厂":detail.processingFactory?.displayName,"返工工序":detail.reworkProcess,"发起时间":detail.createdAt,"发起人":detail.createdBy.displayName,"订单跟单":detail.merchandiser?.displayName,"订单数量":"10","返工数量":"10","需要整查":"否","返工原因":detail.reworkReason}).map(([label,value])=>({label,value:value??null}))};
window.fetch=async(input,init)=>{const path=String(input),method=init?.method??"GET";requests.push({path,method,body:init?.body?JSON.parse(String(init.body)):null});
if(method!=="GET")return Response.json({error:{message:"隔离场景，未提交业务数据"}},{status:403});
if(path.endsWith("auth/me"))return Response.json({status:"authorized",user});
if(path.includes("/history/initiation"))return Response.json(history);
if(path.endsWith("business-detail"))return Response.json(detail);
if(path.endsWith("whole-order-review"))return Response.json(overview);
if(path.endsWith("tail-inspection"))return Response.json({reworkOrderId:orderId,reworkStatus:detail.status,assignments:[],processes:[]});
if(path.endsWith("work-task-adjustment-options"))return Response.json({people:[]});
if(path.endsWith("process-configuration"))return Response.json({reworkOrderId:orderId,reworkStatus:detail.status,orderVersion:7,configuration:null,reworkNo:"RW-TEST"});
if(path.endsWith("work-tasks"))return Response.json({reworkOrderId:orderId,reworkStatus:detail.status,orderVersion:7,tasks:[{workTaskId:id("61"),reworkOrderId:orderId,configurationItemId:processId,processName:"TEST 工序",executionKind:"worker",pricingUnit:"piece",plannedQuantity:10,unitPrice:1,mode:"individual",version:1,status:"active",canSubmitReport:false,members:[{personId:id("7"),displayName:"TEST 工人",personType:"internal"}],submittedQuantity:3,remainingQuantity:7}]});
throw new Error(`Unexpected synthetic read: ${path}`);};
createRoot(document.getElementById("root")!).render(<ReworkDetailPage reworkOrderId={orderId}/>);
