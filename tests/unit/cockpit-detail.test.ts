import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {expect,it} from "vitest";
import {JOURNEY_STAGES,JourneyReturnContextSchema,type JourneyNode,type OrderJourney} from "@dx-rework/contracts/digital-production-journey";
import {CockpitDetail} from "../../apps/web/src/cockpit-detail.js";
const id="00000000-0000-4000-8000-000000000001",task="00000000-0000-4000-8000-000000000002",old="00000000-0000-4000-8000-000000000003";
function fixture():OrderJourney{
  const node=(key:string,patch:Partial<JourneyNode>={}):JourneyNode=>({key,instanceId:key,label:key,stage:"development",state:"active",current:true,round:1,occurrence:1,owner:{id,name:"TEST责任人"},operator:null,assignmentHistory:[],expectedAt:"2026-10-01",expectedKind:"plan",expectedPrecision:"date",actualAt:null,actualQuality:"missing",enteredAt:null,sla:"not_set",completionResult:null,overdueSeconds:null,risks:[],blockers:[],records:[],inheritedFrom:null,countsInProgress:true,unavailableReason:null,...patch});
  const current=node("纸样",{instanceId:task,records:[{domain:"task",id:task,url:`/ui/digital-production?task=${task}`,mode:"handle",version:1,lineId:null}]}),completed=node("核配",{instanceId:old,state:"completed",completionResult:"late",overdueSeconds:999999,actualQuality:"verified",records:[{domain:"task",id:old,url:`/ui/digital-production?task=${old}`,mode:"read",version:1,lineId:null}]});
  return {id,sourceId:id,orderId:id,designStyleNo:"TEST-DETAIL",temporaryStyleNo:null,customer:"PD",category:"上衣",designer:null,styleName:null,merchandisers:[],orderNumbers:[],createdAt:"2026-10-19T00:00:00Z",deliveryDate:null,selectedRound:1,adoptedRound:1,sourceVersion:1,instructionVersion:1,lines:[],links:[],stages:JOURNEY_STAGES.map(stage=>({...stage,state:"pending",nodes:stage.key==="development"?[current,completed]:[]})),progress:{development:{completed:8,applicable:10},bulk:null},hitReasons:[],display:{ruleVersion:"cockpit-display-v1",mainState:"active",earliestShipmentDate:null,missingShipmentDates:0,closedAt:null,actualRatio:.5,actualLabel:"50.0%",awaitingClosure:false,timeRatio:null,timeLabel:"时间规则待完善",stages:JOURNEY_STAGES.map(stage=>({key:stage.key,ratio:.5,applicable:2,completed:1,notApplicable:false,risk:stage.key==="development"?"overdue":"normal"}))},currentRiskNodes:[],currentDeliveryRisks:[],riskHistory:[],operationLog:{items:[],nextCursor:null,asOf:"2026-10-19T00:00:00Z",coverage:["节点事件"]}};
}
const render=(o:OrderJourney,busy=false)=>renderToStaticMarkup(createElement(CockpitDetail,{order:o,context:JourneyReturnContextSchema.parse({selected:id,scope:"production",focus:task}),asOf:"2026-10-19T00:00:00Z",actions:null,busy,onChange(){}}));
it('shows an actual day as a day in both detail and node rows, without an invented midnight or 08:00',()=>{
  const o=fixture(),n=o.stages[1]!.nodes[0]!;n.actualDate='2026-10-17';n.actualAt=null;n.state='completed';
  const html=render(o);expect(html).toContain('<dt>实际完成：</dt><dd>2026-10-17<small>原完成记录，时间待核</small></dd>');expect(html).toContain('<span>2026-10-17</span>');expect(html).not.toContain('2026/10/17 08:00');expect(html).not.toContain('2026-10-17T00:00');
});
it("renders seven double rings with only two date rows, risk color and no invented time ratio",()=>{
  const html=render(fixture());
  expect(html.match(/class="cockpit-stage-rings"/g)).toHaveLength(7);expect(html.match(/class="cockpit-stage-dates"/g)).toHaveLength(7);
  expect(html).toContain('stroke="#d83145"');expect(html).toContain('fill="#d83145"');expect(html).not.toContain("时间规则待完善");expect(html).toContain("业务完成进度");expect(html).not.toContain("含逾期");expect(html).not.toContain("时间100%");expect(html).not.toContain("订单进度 · 全单范围");
});
it("keeps exactly one handling link above the full node table, with completed records read-only",()=>{
  const html=render(fixture());
  expect(html.match(/taskView=handle/g)).toHaveLength(1);expect(html).toContain("进入该节点办理");expect(html).not.toContain("办理当前任务");expect(html).toContain("查看记录");expect(html).toContain("taskView=read");expect(html).toContain("returnTo=");
  expect(render(fixture(),true)).not.toContain("taskView=handle");
});
it("uses current flow dates independently of the selected older node and does not infer a past risk from completionResult",()=>{
  const o=fixture();o.flowStages=structuredClone(o.stages);o.flowStages[1]!.nodes.forEach(node=>node.expectedAt="2026-11-01");
  const html=render(o),flow=html.match(/<section[^>]*cockpit-flow-panel[\s\S]*?<\/section>/)![0];
  expect(flow).toContain("2026-11-01");expect(flow).not.toContain("2026-10-01");expect(html).toContain("2026-10-01");expect(html).not.toContain("999999");
});
it("shows unavailable new facts rather than falling back to old 80% or the selected round's risks",()=>{
  const o=fixture();delete o.display;delete o.currentRiskNodes;delete o.currentDeliveryRisks;delete o.riskHistory;delete o.operationLog;
  const html=render(o);expect(html).toContain("进度资料暂不可用");expect(html).toContain("当前风险资料暂不可用");expect(html).toContain("操作记录暂不可用");expect(html).not.toContain("80%");
});

it.each([['rework','/ui/tasks/'],['production','/ui/production-dashboard/'],['sourcing','/ui/sourcing/orders/']])("keeps the original %s node record reachable when excluded from the directory",(domain,path)=>{const o=fixture();o.stages[1]!.nodes[0]!.records=[{domain,id:task,url:path+task,mode:"read",version:null,lineId:null}];const html=render(o);expect(html).toContain(path+task);expect(html).toContain("查看节点记录");expect(html).not.toContain("进入该节点办理");expect(html).not.toContain("当前身份暂不可办理");});
