import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {expect,it} from "vitest";
import {JOURNEY_STAGES,JourneyReturnContextSchema,type JourneyNode,type OrderJourney} from "@dx-rework/contracts/digital-production-journey";
import {CockpitHome} from "../../apps/web/src/cockpit-home.js";
import {representativeCockpitNodes} from "../../apps/web/src/digital-journey-cockpit-model.js";
const node=(id:string,patch:Partial<JourneyNode>={}):JourneyNode=>({key:id,instanceId:id,label:id,stage:"development",state:"active",current:true,round:1,occurrence:1,owner:null,operator:null,assignmentHistory:[],expectedAt:null,expectedKind:"unset",expectedPrecision:"missing",actualAt:null,actualQuality:"missing",enteredAt:null,sla:"not_started",completionResult:null,overdueSeconds:null,risks:[],blockers:[],records:[],inheritedFrom:null,countsInProgress:true,unavailableReason:null,...patch});
const order=(nodes:JourneyNode[]):OrderJourney=>({id:"00000000-0000-4000-8000-000000000001",sourceId:null,orderId:"00000000-0000-4000-8000-000000000001",designStyleNo:"TEST-HOME",temporaryStyleNo:null,customer:"PD",category:"上衣",designer:null,styleName:null,merchandisers:[],orderNumbers:["TEST-ORDER"],createdAt:"2026-10-19T00:00:00Z",deliveryDate:null,selectedRound:1,adoptedRound:null,sourceVersion:1,instructionVersion:null,lines:[],links:[],stages:JOURNEY_STAGES.map(stage=>({...stage,state:"pending",nodes:nodes.filter(node=>node.stage===stage.key)})),progress:{development:{completed:8,applicable:10},bulk:null},hitReasons:[]});
it("chooses the earliest unresolved risk and retains every parallel current node",()=>{
  const o=order([node("later",{risks:["overdue"],expectedAt:"2026-10-18T12:00:00Z"}),node("earlier",{risks:["overdue"],expectedAt:"2026-10-18T08:00:00Z"}),node("due",{risks:["due_soon"],expectedAt:"2026-10-19T08:00:00Z"}),node("old",{current:false,risks:["overdue"]}),node("done",{state:"completed",risks:["overdue"]})]);
  expect(representativeCockpitNodes(o).map(node=>node.key)).toEqual(["earlier","later","due"]);
  expect(representativeCockpitNodes(order([node("wait",{state:"pending"}),node("active")])).map(node=>node.key)).toEqual(["active"]);
});
it("renders seven compact columns and never substitutes old 80% for unavailable display facts",()=>{
  const o=order([node("work")]);o.styleImageUrl="/TEST.png";
  const html=renderToStaticMarkup(createElement(CockpitHome,{data:{ruleVersion:"journey-v2.0",asOf:"2026-10-19T00:00:00Z",page:1,pageSize:15,total:1,summary:{all:1,active:1,dueSoon:0,overdue:0,blocked:0,completed:0},items:[o]},error:"",context:JourneyReturnContextSchema.parse({scope:"production"}),onChange(){}}));
  expect(html.match(/<th>/g)).toHaveLength(7);expect(html).toContain("时间规则待完善");expect(html).toContain("暂无法读取订单状态");expect(html).toContain("预览TEST-HOME款图");expect(html).not.toContain("80%");expect(html).not.toContain("<small>0%</small>");expect(html).not.toContain(">详情<");
});
it("keeps a real zero distinct from unavailable progress and uses the server's main state",()=>{
  const o=order([node("local-risk",{risks:["overdue"]})]);o.display={ruleVersion:"cockpit-display-v1",mainState:"active",earliestShipmentDate:"2026-11-30",missingShipmentDates:0,closedAt:null,actualRatio:0,actualLabel:"0.0%",awaitingClosure:false,stages:[],timeRatio:null,timeLabel:"时间规则待完善"};
  const html=renderToStaticMarkup(createElement(CockpitHome,{data:{ruleVersion:"journey-v2.0",asOf:"2026-10-19T00:00:00Z",page:1,pageSize:15,total:1,summary:{all:1,active:1,dueSoon:0,overdue:0,blocked:0,completed:0},items:[o]},error:"",context:JourneyReturnContextSchema.parse({scope:"production"}),onChange(){}}));
  expect(html).toContain("0.0%");expect(html).toContain("cockpit-order-state is-active");expect(html).toContain("局部逾期");expect(html).toContain("2026-11-30");expect(html).toContain("未上传款图");
});
