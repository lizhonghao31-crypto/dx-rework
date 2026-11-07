import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {expect,it} from "vitest";
import {JOURNEY_STAGES,JourneyReturnContextSchema,type JourneyNode,type JourneyVisualStage,type OrderJourney} from "@dx-rework/contracts/digital-production-journey";
import {CockpitDetail} from "../../apps/web/src/cockpit-detail.js";
import {CockpitNodeDates} from '../../apps/web/src/cockpit-node-dates.js';
import {nodeTargetLabel} from '../../apps/web/src/journey-sla-details.js';
import {CockpitNodeRows} from '../../apps/web/src/cockpit-node-rows.js';
const id="00000000-0000-4000-8000-000000000001",task="00000000-0000-4000-8000-000000000002",old="00000000-0000-4000-8000-000000000003";
const businessDate=(at:string|null=null)=>({at,precision:at?'date' as const:'unknown' as const,quality:'verified' as const,status:at?'complete' as const:'unknown' as const,covered:at?1:0,total:1,reasons:[]});
const visual=(stage:typeof JOURNEY_STAGES[number],patch:Partial<JourneyVisualStage>={}):JourneyVisualStage=>({key:stage.key,applicability:'applicable',applicable:2,completed:1,unknown:0,actualRatio:.5,timeRatio:null,startedAt:'2026-10-01T00:00:00Z',expected:businessDate(),actual:businessDate(),risk:stage.key==='development'?'overdue':'normal',...patch});
function fixture():OrderJourney{
  const node=(key:string,patch:Partial<JourneyNode>={}):JourneyNode=>({key,instanceId:key,label:key,stage:"development",state:"active",current:true,round:1,occurrence:1,owner:{id,name:"TEST责任人"},operator:null,assignmentHistory:[],expectedAt:"2026-10-01",expectedKind:"plan",expectedPrecision:"date",actualAt:null,actualQuality:"missing",enteredAt:null,sla:"not_set",completionResult:null,overdueSeconds:null,risks:[],blockers:[],records:[],inheritedFrom:null,countsInProgress:true,unavailableReason:null,...patch});
  const current=node("纸样",{instanceId:task,records:[{domain:"task",id:task,url:`/ui/digital-production?task=${task}`,mode:"handle",version:1,lineId:null}]}),completed=node("核配",{instanceId:old,state:"completed",completionResult:"late",overdueSeconds:999999,actualQuality:"verified",records:[{domain:"task",id:old,url:`/ui/digital-production?task=${old}`,mode:"read",version:1,lineId:null}]});
  return {visualProgress:{ruleVersion:'journey-visual-v1',asOf:'2026-10-19T00:00:00Z',actualRatio:.5,timeRatio:null,startedAt:null,applicableStages:7,completedStages:0,unknownStages:0,expected:businessDate(),actual:businessDate(),stages:JOURNEY_STAGES.map(stage=>visual(stage))},id,sourceId:id,orderId:id,designStyleNo:"TEST-DETAIL",temporaryStyleNo:null,customer:"PD",category:"上衣",designer:null,styleName:null,merchandisers:[],orderNumbers:[],createdAt:"2026-10-19T00:00:00Z",deliveryDate:null,selectedRound:1,adoptedRound:1,sourceVersion:1,instructionVersion:1,lines:[],links:[],stages:JOURNEY_STAGES.map(stage=>({...stage,state:"pending",nodes:stage.key==="development"?[current,completed]:[]})),progress:{development:{completed:8,applicable:10},bulk:null},hitReasons:[],display:{ruleVersion:"cockpit-display-v1",mainState:"active",earliestShipmentDate:null,missingShipmentDates:0,closedAt:null,actualRatio:.5,actualLabel:"50.0%",awaitingClosure:false,timeRatio:null,timeLabel:"时间规则待完善",stages:JOURNEY_STAGES.map(stage=>({key:stage.key,ratio:.5,applicable:2,completed:1,notApplicable:false,risk:stage.key==="development"?"overdue":"normal"}))},currentRiskNodes:[],currentDeliveryRisks:[],riskHistory:[],operationLog:{items:[],nextCursor:null,asOf:"2026-10-19T00:00:00Z",coverage:["节点事件"]}};
}
const render=(o:OrderJourney,busy=false)=>renderToStaticMarkup(createElement(CockpitDetail,{order:o,context:JourneyReturnContextSchema.parse({selected:id,scope:"production",focus:task}),asOf:"2026-10-19T00:00:00Z",actions:null,busy,onChange(){}}));
it('R2-02 Review: node table exposes an original batch deadline when the generic task deadline is missing',()=>{
 const n=fixture().stages[1]!.nodes[0]!;n.expectedAt=null;n.expectedKind='unset';n.nativeWindows=[{evidence:'TEST-native-D',scopeLabel:'PO TEST',startedAt:null,deadline:'2026-11-12T03:35:00Z',warningAt:null,completedAt:null,complete:false}];
 const html=renderToStaticMarkup(createElement(CockpitNodeRows,{nodes:[n],context:JourneyReturnContextSchema.parse({selected:id}),selectedId:undefined,asOf:undefined,onSelect(){}}));
 expect(html).toContain('2026/11/12 11:35:00');expect(html).not.toContain('未登记');expect(html).not.toContain('原任务截止');
});
it('R2-02 Review: node table marks multiple original batches and retains the separate original task date boundary',()=>{
 const n=fixture().stages[1]!.nodes[0]!;n.expectedAt='2030-01-01T16:00:00Z';n.expectedKind='sla';n.deadlineMode='date_target';n.deadlineExclusive=true;n.nativeWindows=['A','B'].map(evidence=>({evidence,scopeLabel:'PO TEST-'+evidence,startedAt:null,deadline:'2026-11-12T03:35:00Z',warningAt:null,completedAt:null,complete:false}));
 const html=renderToStaticMarkup(createElement(CockpitNodeRows,{nodes:[n],context:JourneyReturnContextSchema.parse({selected:id}),selectedId:undefined,asOf:undefined,onSelect(){}}));
 expect(html).toContain('各批原截止见节点');expect(html).toContain('原任务截止：2030/1/1 当天结束');expect(html).not.toContain('2030/1/2');
});
it('R2-02: native completed batch deadlines remain directly readable without replacing them with a generic task date',()=>{
 const o=fixture(),n=o.stages[1]!.nodes[0]!;n.expectedAt='2030-01-01T00:00:00Z';n.expectedPrecision='instant';n.expectedKind='sla';n.nativeWindows=[{evidence:'TEST-source-fact',scopeLabel:'PO TEST-ORIGINAL · 黑',startedAt:'2026-11-02T00:00:00Z',deadline:'2026-11-03T00:00:00Z',warningAt:null,completedAt:'2026-11-02T00:01:00Z',complete:true,snapshotId:'TEST-private-snapshot'}];
 const before=structuredClone(n),html=renderToStaticMarkup(createElement(CockpitNodeDates,{node:n,order:o}));
 expect(nodeTargetLabel(n)).toBe('2026/11/3 08:00:00');expect(html).toContain('原批次时限');expect(html).toContain('原截止 2026/11/3 08:00');expect(html).toContain('已完成 2026/11/2 08:01');expect(html).not.toContain('TEST-private-snapshot');expect(html).toContain('2030/1/1 08:00');expect(n).toEqual(before);
 n.expectedAt=null;const noGeneric=renderToStaticMarkup(createElement(CockpitNodeDates,{node:n,order:o}));expect(noGeneric).toContain('原截止 2026/11/3 08:00');expect(noGeneric).not.toContain('尚无可信截止');
});
it('R2-02: directly shows every original PO target with its date boundary and never presents a logistics estimate as a hard deadline',()=>{
 const o=fixture(),n=o.stages[1]!.nodes[0]!;n.expectedAt=null;n.expectedKind='unset';n.records=[];o.lines=['A','B'].map(id=>({id,po:'TEST-PO-'+id,color:id,formalStyleNo:null,temporaryStyleNo:null,orderedQuantity:1}));
 const target=(at:string|null,exclusive=false)=>({at,exclusive,reasons:[]});
 const template={label:'原工厂交期',stage:'production' as const,kind:'order_date',status:'not_started' as const,actualStart:null,actualEnd:null,target:target(null),forecast:target(null),forecastBasis:'unknown' as const,original:target(null),current:target(null)};
 n.timings=[{...template,id:'factory_production:A',target:target('2026-11-09T16:00:00.000Z',true)},{...template,id:'factory_production:B',target:target('2026-11-11T08:00:00.000Z')},{...template,id:'process_logistics:A',kind:'estimate',label:'原物流预计',forecast:target('2026-11-12T08:00:00.000Z')}];
 const before=structuredClone(n),html=renderToStaticMarkup(createElement(CockpitNodeDates,{node:n,order:o}));
 expect(html).toContain('PO TEST-PO-A · A原截止');expect(html).toContain('2026/11/9 当天结束');expect(html).toContain('PO TEST-PO-B · B原截止');expect(html).toContain('2026/11/11 16:00');expect(html).toContain('物流预计：');expect(html).toContain('（仅预计）');expect(html).not.toContain('尚无可信截止');expect(n).toEqual(before);
});
it('shows an actual day as a day in both detail and node rows, without an invented midnight or 08:00',()=>{
  const o=fixture(),n=o.stages[1]!.nodes[0]!;n.actualDate='2026-10-17';n.actualAt=null;n.state='completed';
  const html=render(o);expect(html).toContain('<dt>实际完成：</dt><dd>2026-10-17<small>原完成记录，时间待核</small></dd>');expect(html).toContain('<span>2026-10-17</span>');expect(html).not.toContain('2026/10/17 08:00');expect(html).not.toContain('2026-10-17T00:00');
});
it("renders seven double rings with only two date rows, risk color and no invented time ratio",()=>{
  const html=render(fixture());
  expect(html).not.toContain("节点全流程一览");expect(html.match(/class="cockpit-stage-rings"/g)).toHaveLength(7);expect(html.match(/class="cockpit-stage-dates"/g)).toHaveLength(7);
  expect(html).toContain('is-danger');expect(html).toContain('stroke-dasharray="50 100"');expect(html).not.toContain("时间规则待完善");expect(html).toContain("实际进度");expect(html).not.toContain("计划与时效");expect(html).not.toContain("含逾期");expect(html).not.toContain("时间100%");expect(html).not.toContain("订单进度 · 全单范围");
});
it("keeps exactly one handling link above the full node table, with completed records read-only",()=>{
  const html=render(fixture());
  expect(html.match(/taskView=handle/g)).toHaveLength(1);expect(html).toContain("进入该节点办理");expect(html).not.toContain("办理当前任务");expect(html).toContain("查看记录");expect(html).toContain("taskView=read");expect(html).toContain("returnTo=");
  expect(render(fixture(),true)).not.toContain("taskView=handle");
});
it("uses current flow dates independently of the selected older node and does not infer a past risk from completionResult",()=>{
  const o=fixture();o.flowStages=structuredClone(o.stages);o.flowStages[1]!.nodes.forEach(node=>node.expectedAt="2026-11-01");o.visualProgress!.stages[1]!.expected=businessDate("2026-11-01");
  const html=render(o),flow=html.match(/<section[^>]*cockpit-flow-panel[\s\S]*?<\/section>/)![0];
  expect(flow).toContain("2026-11-01");expect(flow).not.toContain("2026-10-01");expect(html).toContain("2026-10-01");expect(html).not.toContain("999999");
});
it("shows unavailable new facts rather than falling back to old 80% or the selected round's risks",()=>{
  const o=fixture();delete o.visualProgress;delete o.display;delete o.currentRiskNodes;delete o.currentDeliveryRisks;delete o.riskHistory;delete o.operationLog;
  const html=render(o);expect(html).not.toContain("cockpit-stage-arc");expect(html.match(/时间进度 <b>—/g)).toHaveLength(7);expect(html).toContain("当前风险资料暂不可用");expect(html).toContain("操作记录暂不可用");expect(html).not.toContain("80%");
});

it.each([['rework','/ui/tasks/'],['production','/ui/production-dashboard/'],['sourcing','/ui/sourcing/orders/']])("keeps the original %s node record reachable when excluded from the directory",(domain,path)=>{const o=fixture();o.stages[1]!.nodes[0]!.records=[{domain,id:task,url:path+task,mode:"read",version:null,lineId:null}];const html=render(o);expect(html).toContain(path+task);expect(html).toContain("查看节点记录");expect(html).not.toContain("进入该节点办理");expect(html).not.toContain("当前身份暂不可办理");});

it.each([[0,'0%',false],[.364,'36.4%',true],[1,'100%',true],[null,'—',false]] as const)('R3-03 keeps the shared ratio %s distinct from unknown and from an old flat completion count', (ratio,label,arc)=>{
 const o=fixture();o.visualProgress!.stages=o.visualProgress!.stages.map(stage=>({...stage,actualRatio:ratio,timeRatio:ratio}));o.display!.mainState='completed';
 const html=render(o);expect(html).toContain(`实际进度 <b>${label}</b>`);expect(html.includes('cockpit-stage-arc')).toBe(arc);expect(html).not.toContain('80%');if(ratio!==1)expect(html).not.toContain('>✓</text>');
});

it.each([[.4,.8],[1,.6]])('Final10 renders independent time %s and actual %s arcs without rounding either to completion', (time,actual)=>{
 const o=fixture();o.visualProgress!.stages=o.visualProgress!.stages.map(stage=>({...stage,timeRatio:time!,actualRatio:actual!}));
 const html=render(o);expect(html.match(new RegExp(`class="cockpit-stage-arc is-time"[^>]*stroke-dasharray="${time!*100} 100"`,'g'))).toHaveLength(7);expect(html.match(new RegExp(`class="cockpit-stage-arc is-actual"[^>]*stroke-dasharray="${actual!*100} 100"`,'g'))).toHaveLength(7);expect(html).not.toContain('>✓</text>');
});

it.each([['overdue','danger'],['due_soon','warning'],['normal','neutral'],['unknown','neutral']] as const)('R3-03 Review preserves known %s with no verified stage start or completed work', (risk,tone)=>{
 const o=fixture();o.visualProgress!.stages=o.visualProgress!.stages.map(stage=>({...stage,risk,startedAt:null,actualRatio:0,timeRatio:null}));
 const html=render(o);expect(html.match(new RegExp(`class="cockpit-stage[^"]* is-${tone}"`,'g'))).toHaveLength(7);expect(html.match(/时间进度 <b>—/g)).toHaveLength(7);expect(html.match(/实际进度 <b>0%/g)).toHaveLength(7);expect(html).not.toContain('cockpit-stage-arc');
});
