import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {expect,it} from "vitest";
import {JOURNEY_STAGES,JourneyReturnContextSchema,type JourneyNode,type OrderJourney} from "@dx-rework/contracts/digital-production-journey";
import {CockpitHome} from "../../apps/web/src/cockpit-home.js";
import {representativeCockpitNodes} from "../../apps/web/src/digital-journey-cockpit-model.js";
import {CockpitHomeRisks,cockpitHomeRisks} from '../../apps/web/src/cockpit-home-risks.js';
import {CockpitHomeProgress,cockpitReceiptGap} from '../../apps/web/src/cockpit-home-progress.js';
const node=(id:string,patch:Partial<JourneyNode>={}):JourneyNode=>({key:id,instanceId:id,label:id,stage:"development",state:"active",current:true,round:1,occurrence:1,owner:null,operator:null,assignmentHistory:[],expectedAt:null,expectedKind:"unset",expectedPrecision:"missing",actualAt:null,actualQuality:"missing",enteredAt:null,sla:"not_started",completionResult:null,overdueSeconds:null,risks:[],blockers:[],records:[],inheritedFrom:null,countsInProgress:true,unavailableReason:null,...patch});
const order=(nodes:JourneyNode[]):OrderJourney=>({id:"00000000-0000-4000-8000-000000000001",sourceId:null,orderId:"00000000-0000-4000-8000-000000000001",designStyleNo:"TEST-HOME",temporaryStyleNo:null,customer:"PD",category:"上衣",designer:null,styleName:null,merchandisers:[],orderNumbers:["TEST-ORDER"],createdAt:"2026-10-19T00:00:00Z",deliveryDate:null,selectedRound:1,adoptedRound:null,sourceVersion:1,instructionVersion:null,lines:[],links:[],stages:JOURNEY_STAGES.map(stage=>({...stage,state:"pending",nodes:nodes.filter(node=>node.stage===stage.key)})),progress:{development:{completed:8,applicable:10},bulk:null},hitReasons:[]});
const missingDate=()=>({at:null,precision:'unknown' as const,quality:'unknown' as const,status:'unknown' as const,covered:0,total:0,reasons:[]});
const visual=(actualRatio:number|null,timeRatio:number|null=null):NonNullable<OrderJourney['visualProgress']>=>({ruleVersion:'journey-visual-v1',asOf:'2026-10-19T00:00:00Z',actualRatio,timeRatio,startedAt:null,applicableStages:7,completedStages:0,unknownStages:0,expected:missingDate(),actual:missingDate(),stages:[]});
const home=(o:OrderJourney)=>renderToStaticMarkup(createElement(CockpitHome,{data:{ruleVersion:'journey-v2.0',asOf:'2026-11-07T00:00:00Z',page:1,pageSize:15,total:1,summary:{all:1,active:1,dueSoon:0,overdue:0,blocked:0,completed:0},items:[o]},error:'',context:JourneyReturnContextSchema.parse({scope:'production'}),onChange(){}}));
it('R3 Review preserves original date-target exclusive and native batch deadline semantics in the homepage and all-risk modal',()=>{
 const n=node('TEST-date-target',{expectedAt:'2026-11-07T16:00:00.000Z',expectedPrecision:'date',expectedKind:'sla',deadlineMode:'date_target',deadlineExclusive:true,risks:['overdue'],records:[{domain:'task',id:'TEST-date-target',url:'/ui/digital-production?task=TEST-date-target',mode:'read',version:1,lineId:null}]}),o=order([n]),context=JourneyReturnContextSchema.parse({scope:'production'});
 const modal=()=>renderToStaticMarkup(createElement(CockpitHomeRisks,{order:o,context,onClose(){},onNode(){},onOrder(){}}));
 for(const html of [home(o),modal()]){expect(html).toContain('2026/11/7 当天结束');expect(html).not.toContain('2026-11-07T16:00');expect(html).not.toContain('2026/11/8');}
 const noDeadline=home(order([node('TEST-original-unset')]));expect(noDeadline).not.toContain('尚无可信截止');expect(noDeadline).not.toContain('原截止待核');
 n.nativeWindows=[{evidence:'TEST-original-batch',scopeLabel:'PO TEST',startedAt:null,deadline:'2026-11-06T03:35:00Z',warningAt:null,completedAt:null,complete:false}];
 for(const html of [home(o),modal()]){expect(html).toContain('2026/11/6 11:35:00');expect(html).not.toContain('2026/11/7 当天结束');}
});
it('R3 Review retains every original series planning risk without adding planning nodes to execution progress',()=>{
 const o=order([node('series_material_ready',{stage:'preparation',planningOnly:true,countsInProgress:false,risks:['overdue']}),node('series_processing_dispatch',{stage:'post_cutting',planningOnly:true,countsInProgress:false,risks:['overdue']}),node('series_done',{planningOnly:true,countsInProgress:false,state:'completed',risks:['overdue']})]),before=structuredClone(o),context=JourneyReturnContextSchema.parse({scope:'production'});
 const risks=cockpitHomeRisks(o,context),html=home(o),modal=renderToStaticMarkup(createElement(CockpitHomeRisks,{order:o,context,onClose(){},onNode(){},onOrder(){}}));
 expect(risks.nodes.map(n=>n.key)).toEqual(['series_material_ready','series_processing_dispatch']);expect(risks.total).toBe(2);expect(html).toContain('全部2项风险');expect(html).toContain('另 1 项风险');for(const key of ['series_material_ready','series_processing_dispatch'])expect(modal).toContain(key);expect(modal).not.toContain('series_done');expect(o).toEqual(before);expect(html).not.toContain('aria-valuenow=');
 expect(cockpitHomeRisks(o,{...context,stage:'preparation'}).nodes.map(n=>n.key)).toEqual(['series_material_ready']);
});
it('consumes only the shared visual projection, keeps partial progress below 100, and distinguishes full, visible and unavailable receipt debt',()=>{
 const o=order([]),render=()=>renderToStaticMarkup(createElement(CockpitHomeProgress,{order:o}));
 o.visualProgress=visual(.7083333333,.25);expect(render()).toContain('aria-valuenow="70.8"');expect(render()).toContain('aria-valuenow="25"');expect(render()).not.toContain('80%');
 o.visualProgress=visual(.9999999);expect(render()).toContain('aria-valuenow="99.9"');expect(render()).not.toContain('title="100%"');
 o.visualProgress=visual(1);expect(render()).toContain('title="100%"');
 o.visualProgress=visual(null);expect(render()).not.toContain('aria-valuenow=');
 o.lines=[{id:'line1',po:'TEST-PO',color:'蓝',orderedQuantity:4,formalStyleNo:null,temporaryStyleNo:null}];
 o.businessProgress={ruleVersion:'journey-business-v1',asOf:'2026-10-19T00:00:00Z',requirements:[],applicable:0,completed:0,unknown:0,ratio:null,stages:[],plan:{status:'not_adopted',planId:null,revision:null,covered:0,missing:0,due:0,outstandingDue:[],reasons:[]},quantities:{revision:'TEST',factoryAttribution:'unknown',lines:[{lineId:'line1',demand:4,received:2,packed:2,inspected:null,qualified:null,remainingReceipt:2,remainingShipment:2,qualityGap:null,qualityConflict:false,factoryAttribution:'unknown',reasons:[]}]}};
 expect(render()).not.toContain('欠收');expect(home(o)).toContain('欠收 2件');expect(home(o)).not.toContain('可见范围欠收');
 o.lines.push({...o.lines[0]!,id:'line2'});expect(home(o)).toContain('可见范围欠收 2件');
 o.businessProgress!.quantities!.lines[0]!.remainingReceipt=NaN;expect(home(o)).not.toContain('欠收');
 o.businessProgress!.quantities!.lines[0]!.remainingReceipt=2;o.businessProgress!.quantities!.lines.push({...o.businessProgress!.quantities!.lines[0]!});expect(cockpitReceiptGap(o)).toBeNull();
 o.businessProgress!.quantities!.lines.splice(1);o.businessProgress!.quantities!.lines[0]!.lineId='unreadable-line';expect(cockpitReceiptGap(o)).toBeNull();
});
it("chooses the earliest unresolved risk and retains every parallel current node",()=>{
  const o=order([node("later",{risks:["overdue"],expectedAt:"2026-10-18T12:00:00Z"}),node("earlier",{risks:["overdue"],expectedAt:"2026-10-18T08:00:00Z"}),node("due",{risks:["due_soon"],expectedAt:"2026-10-19T08:00:00Z"}),node("old",{current:false,risks:["overdue"]}),node("done",{state:"completed",risks:["overdue"]})]);
  expect(representativeCockpitNodes(o).map(node=>node.key)).toEqual(["earlier","later","due"]);
  expect(representativeCockpitNodes(order([node("wait",{state:"pending"}),node("active")])).map(node=>node.key)).toEqual(["active"]);
});
it("renders seven compact columns and never substitutes old 80% for unavailable display facts",()=>{
  const o=order([node("work")]);o.styleImageUrl="/TEST.png";
  const html=renderToStaticMarkup(createElement(CockpitHome,{data:{ruleVersion:"journey-v2.0",asOf:"2026-10-19T00:00:00Z",page:1,pageSize:15,total:1,summary:{all:1,active:1,dueSoon:0,overdue:0,blocked:0,completed:0},items:[o]},error:"",context:JourneyReturnContextSchema.parse({scope:"production"}),onChange(){}}));
  expect(html.match(/<th(?:\s|>)/g)).toHaveLength(7);expect(html).not.toContain("时间规则待完善");expect(html).toContain('aria-label="整单时间进度"');expect(html).toContain('aria-label="整单实际进度"');expect(html).not.toContain('aria-valuenow=');expect(html).toContain("预览TEST-HOME款图");expect(html).not.toContain("80%");expect(html).not.toContain("<small>0%</small>");expect(html).not.toContain(">详情<");expect(html).toContain('订单ID：—');
  expect(html.indexOf('data-progress-kind="time"')).toBeLessThan(html.indexOf('data-progress-kind="actual"'));expect(html.indexOf('data-progress-kind="actual"')).toBeLessThan(html.indexOf('预计完成'));expect(html.indexOf('预计完成')).toBeLessThan(html.indexOf('实际完成'));expect(html).toContain('时间 —');expect(html).toContain('实际 —');
});
it("keeps a real zero distinct from unavailable progress and uses the server's main state",()=>{
  const o=order([node("local-risk",{risks:["overdue"]})]);o.display={ruleVersion:"cockpit-display-v1",mainState:"active",earliestShipmentDate:"2026-11-30",missingShipmentDates:0,closedAt:null,actualRatio:0,actualLabel:"0.0%",awaitingClosure:false,stages:[],timeRatio:null,timeLabel:"时间规则待完善"};
  o.visualProgress=visual(0);o.visualProgress.expected={at:'2026-11-30',precision:'date',quality:'recorded',status:'complete',covered:1,total:1,reasons:[]};
  const html=renderToStaticMarkup(createElement(CockpitHome,{data:{ruleVersion:"journey-v2.0",asOf:"2026-10-19T00:00:00Z",page:1,pageSize:15,total:1,summary:{all:1,active:1,dueSoon:0,overdue:0,blocked:0,completed:0},items:[o]},error:"",context:JourneyReturnContextSchema.parse({scope:"production"}),onChange(){}}));
  expect(html).toContain('aria-valuenow="0"');expect(html).toContain('title="0%"');expect(html).toContain("cockpit-order-state is-active");expect(html).toContain('dx-badge--danger">逾期');expect(html).toContain("2026-11-30");expect(html).not.toContain('2026-11-30 00:00');expect(html).toContain("未上传款图");
});
it("keeps unknown completion and retained original risks without turning closure into 100 percent",()=>{
  const o=order([node("original-work",{risks:["overdue"]})]);
  o.display={ruleVersion:"cockpit-display-v1",mainState:"completed",earliestShipmentDate:null,missingShipmentDates:0,closedAt:null,actualRatio:null,actualLabel:"回货与装箱资料待核",awaitingClosure:false,stages:[{key:"creation",ratio:1,applicable:1,completed:1,notApplicable:false,risk:"normal"},{key:"receiving",ratio:null,applicable:null,completed:null,notApplicable:false,risk:"unknown"}],timeRatio:null,timeLabel:"时间规则待完善"};
  const html=renderToStaticMarkup(createElement(CockpitHome,{data:{ruleVersion:"journey-v2.0",asOf:"2026-10-19T00:00:00Z",page:1,pageSize:15,total:1,summary:{all:1,active:0,dueSoon:0,overdue:0,blocked:0,completed:1},items:[o]},error:"",context:JourneyReturnContextSchema.parse({scope:"production"}),onChange(){}}));
  expect(html).not.toContain("整单已收口 · 保留的原节点状态");expect(html).not.toContain("original-work");expect(html).toContain('全部1项风险');
  const context=JourneyReturnContextSchema.parse({scope:'production'}),risks=cockpitHomeRisks(o,context),modal=renderToStaticMarkup(createElement(CockpitHomeRisks,{order:o,context,onClose(){},onNode(){},onOrder(){}}));
  expect(risks.nodes.map(n=>n.key)).toEqual(['original-work']);expect(modal).toContain('original-work');expect(modal).toContain('已逾期');expect(modal).toContain('已收口订单保留的节点风险');
  expect(html).not.toContain("100%");expect(html).not.toContain("100.0%");expect(html).not.toContain('aria-valuenow=');
  expect(o.display.actualRatio).toBeNull();
});
it("keeps independent factory/sample risks and concrete blockers visible without changing the mother state",()=>{
  const o=order([node("development_pattern",{state:"blocked",blockers:[{key:"materials",label:"本轮主布尚未齐料",ownerId:null,record:null},{key:"handover",label:"交接单尚未确认",ownerId:null,record:null}]}),node("production_reporting",{stage:"production",state:"pending"}),node("bulk_ship_sample",{stage:"production",state:"pending"})]);
  o.display={ruleVersion:"cockpit-display-v1",mainState:"active",earliestShipmentDate:"2026-11-30",missingShipmentDates:0,closedAt:null,actualRatio:0,actualLabel:"0.0%",awaitingClosure:false,stages:[],timeRatio:null,timeLabel:"时间规则待完善"};
  o.deliveryRisks=[{lineId:"PO-1",poNumber:"PO-1",color:"蓝",kind:"factory",date:"2026-10-18",risk:"overdue",nodeKey:"production_reporting"},{lineId:"PO-2",poNumber:"PO-2",color:"红",kind:"sample",date:"2026-10-19",risk:"due_soon",nodeKey:"bulk_ship_sample"}];
  const render=(context:ReturnType<typeof JourneyReturnContextSchema.parse>)=>renderToStaticMarkup(createElement(CockpitHome,{data:{ruleVersion:"journey-v2.0",asOf:"2026-10-19T00:00:00Z",page:1,pageSize:15,total:1,summary:{all:1,active:1,dueSoon:0,overdue:0,blocked:1,completed:0},items:[o]},error:"",context,onChange(){}}));
  const context=JourneyReturnContextSchema.parse({scope:'production'}),html=render(context);expect(html).toContain("本轮主布尚未齐料");expect(html).not.toContain("加工厂交货日");expect(html).toContain('另 2 项风险');expect(html).toContain("cockpit-order-state is-active");
  const modal=renderToStaticMarkup(createElement(CockpitHomeRisks,{order:o,context,onClose(){},onNode(){},onOrder(){}}));expect(modal).toContain('加工厂交货日');expect(modal).toContain('约定日期已过');expect(modal).toContain('船样目标日');expect(modal).toContain('今天到期');expect(modal).toContain('交接单尚未确认');expect(modal).toContain('本轮主布尚未齐料');
  o.stages[1]!.nodes[0]!.blockers=[];o.stages[1]!.nodes[0]!.state="active";const ordinary=render(JourneyReturnContextSchema.parse({scope:"production"}));expect(ordinary).toContain("项风险");expect(ordinary).toContain("cockpit-order-state is-active");
  o.display.mainState="due_soon";const dueMother=render(JourneyReturnContextSchema.parse({scope:"production",kpi:"due_soon"}));expect(dueMother).toContain("项风险");expect(dueMother).toContain("cockpit-order-state is-due_soon");
  const filtered=render(JourneyReturnContextSchema.parse({scope:"production",risk:"due_soon"}));expect(filtered).not.toContain("约定日期已过");expect(filtered).toContain("船样目标日");
});

it('R2-01: pending result submission is not presented as a blocker and actual blockers stay visible',()=>{
 const o=order([node('work',{blockers:[{key:'completion:submitted',label:'完成办理前：本次结果尚未提交',ownerId:null,record:null},{key:'materials',label:'本轮主布尚未齐料',ownerId:null,record:null}]})]);
 const before=structuredClone(o),html=renderToStaticMarkup(createElement(CockpitHome,{data:{ruleVersion:'journey-v2.0',asOf:'2026-10-19T00:00:00Z',page:1,pageSize:15,total:1,summary:{all:1,active:1,dueSoon:0,overdue:0,blocked:0,completed:0},items:[o]},error:'',context:JourneyReturnContextSchema.parse({scope:'production'}),onChange(){}}));
 expect(html).not.toContain('完成办理前');expect(html).toContain('本轮主布尚未齐料');expect(html).toContain('进行中');expect(o).toEqual(before);
});
