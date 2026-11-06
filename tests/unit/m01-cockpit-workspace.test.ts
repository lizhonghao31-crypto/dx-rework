import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect,it} from 'vitest';
import {JOURNEY_STAGES,JourneyFilterSchema,JourneyReturnContextSchema,type JourneyNode,type OrderJourney} from '@dx-rework/contracts/digital-production-journey';
import {selectJourneys} from '../../apps/api/src/production-platform/journey-projection.js';
import {representativeCockpitNodes} from '../../apps/web/src/digital-journey-cockpit-model.js';
import {PoOrderFacts,PoOrderSummary,sortedCockpitPoLines} from '../../apps/web/src/po-delivery-dates.js';
import {CockpitBusinessProgress,CockpitReceiptSummary} from '../../apps/web/src/cockpit-business-progress.js';
const id='00000000-0000-4000-8000-000000000001';
it('R2-02: displays one trusted formal PO alias once while retaining a different existing style and missing PO state',()=>{
 const order=fixture();order.orderId=id;order.lines=[{id:'A',po:'TEST-PO-A',color:'黑',formalStyleNo:'test-po-a',temporaryStyleNo:null,orderedQuantity:1},{id:'B',po:'TEST-PO-B',color:'白',formalStyleNo:'TEST-STYLE-B',temporaryStyleNo:null,orderedQuantity:2},{id:'C',po:null,color:'红',formalStyleNo:null,temporaryStyleNo:null,orderedQuantity:3}];
 const before=structuredClone(order),html=renderToStaticMarkup(createElement(PoOrderFacts,{order}));
 expect(html).toContain('>TEST-PO-A</td>');expect(html).not.toContain('TEST-PO-A /');expect(html).toContain('TEST-PO-B / TEST-STYLE-B');expect(html).toContain('待补PO');expect(html).not.toContain(id);expect(order).toEqual(before);
});
const node=(key:string,stage:JourneyNode['stage'],patch:Partial<JourneyNode>={}):JourneyNode=>({key,instanceId:key,label:key,stage,state:'active',current:true,round:null,occurrence:1,owner:null,operator:null,assignmentHistory:[],expectedAt:null,expectedKind:'unset',expectedPrecision:'missing',actualAt:null,actualQuality:'missing',enteredAt:null,sla:'not_set',completionResult:null,overdueSeconds:null,risks:[],blockers:[],records:[],inheritedFrom:null,countsInProgress:true,unavailableReason:null,...patch});
function fixture():OrderJourney{
 const nodes=[node('prep','preparation'),node('factory','production',{state:'blocked',risks:['overdue','blocked']})];
 return {id,sourceId:id,orderId:id,designStyleNo:'TEST-P04',temporaryStyleNo:null,customer:'TEST',category:null,designer:null,styleName:null,merchandisers:[],orderNumbers:[],createdAt:'2026-11-01T00:00:00Z',deliveryDate:null,selectedRound:1,adoptedRound:1,sourceVersion:5,instructionVersion:6,lines:[],links:[],stages:JOURNEY_STAGES.map(stage=>({...stage,state:'active',nodes:nodes.filter(n=>n.stage===stage.key)})),progress:{development:null,bulk:null},hitReasons:[],display:{ruleVersion:'cockpit-display-v1',mainState:'overdue',earliestShipmentDate:'2026-11-01',missingShipmentDates:0,closedAt:null,actualRatio:0,actualLabel:'0%',awaitingClosure:false,stages:[],timeRatio:null,timeLabel:'时间规则待完善'}};
}
it('P04-02: keeps stage risks and representative tasks within preparation while whole-order customer overdue stays visible',()=>{
 const order=fixture(),filter=JourneyFilterSchema.parse({scope:'production',stage:'preparation'}),result=selectJourneys([order],filter,'2026-11-05T00:00:00Z');
 expect(result.summary).toMatchObject({all:1,overdue:1,blocked:0});expect(result.supervision).toMatchObject({overdue:0,dueSoon:0});expect(result.items).toHaveLength(1);
 expect(representativeCockpitNodes(order,JourneyReturnContextSchema.parse(filter)).map(n=>n.key)).toEqual(['prep']);
 expect(selectJourneys([order],{...filter,kpi:'blocked'},'2026-11-05T00:00:00Z').total).toBe(0);
 const all=selectJourneys([order],{...filter,stage:undefined},'2026-11-05T00:00:00Z');expect(all.summary.blocked).toBe(1);expect(all.supervision?.overdue).toBe(1);
 const legacy=selectJourneys([order],JourneyFilterSchema.parse({}),'2026-11-05T00:00:00Z');expect(legacy.summary.blocked).toBe(1);
});
it('P04-02: does not invent a task from another phase when the selected phase has completed or unavailable nodes',()=>{
 const order=fixture();order.stages.find(s=>s.key==='preparation')!.nodes[0]!.state='completed';
 expect(representativeCockpitNodes(order,{stage:'preparation'})).toEqual([]);expect(representativeCockpitNodes(order).map(n=>n.key)).toEqual(['factory']);
});
it('P04-02: a closed parent does not revive a retained blocked node as current work',()=>{
 const order=fixture();order.display!.mainState='completed';const result=selectJourneys([order],JourneyFilterSchema.parse({scope:'production'}),'2026-11-05T00:00:00Z');expect(result.summary).toMatchObject({all:1,completed:1,blocked:0});expect(result.supervision?.overdue).toBe(0);expect(selectJourneys([order],JourneyFilterSchema.parse({scope:'production',kpi:'blocked'}),'2026-11-05T00:00:00Z').total).toBe(0);
});
it('P04-01: sorts customer dates then natural PO then stable identity, and keeps the independent earliest factory date',()=>{
 const order=fixture(),make=(id:string,po:string)=>({id,po,color:'TEST黑',formalStyleNo:null,temporaryStyleNo:null,orderedQuantity:1});order.lines=[make('z','PO10'),make('b','PO2'),make('later','PO1'),make('missing','PO0'),make('a','PO02')];
 order.poDeliveryDates=order.lines.map((line,index)=>({lineId:line.id,position:index+1,poNumber:line.po,color:line.color,customerWarehouseArrivalDate:line.id==='missing'?null:line.id==='later'?'2026-11-12':'2026-11-11',factoryDeliveryDate:line.id==='later'?'2026-11-03':'2026-11-09',sampleTargetDate:null}));
 expect(sortedCockpitPoLines(order).map(line=>line.id)).toEqual(['a','b','z','later','missing']);
 const html=renderToStaticMarkup(createElement(PoOrderSummary,{order}));expect(html).toContain('2026-11-11 · PO10、PO2、PO02');expect(html).toContain('最早加工厂交货日：2026-11-03 · PO1');expect(html).toContain('1个PO出货日期待补');expect(html).not.toContain('PO0 · 2026-11-03');
});
it('P04-13: shows the native whole receipt shortage beside unknown factory attribution without changing QC or packed facts',()=>{
 const order=fixture();order.lines=[{id:'F',po:'TEST-F',color:'黑',formalStyleNo:null,temporaryStyleNo:null,orderedQuantity:4}];
 order.businessProgress={ruleVersion:'journey-business-v1',asOf:'2026-11-05T00:00:00Z',requirements:[],applicable:4,completed:2,unknown:0,ratio:.5,stages:[],plan:{status:'not_adopted',planId:null,revision:null,covered:0,missing:4,due:0,outstandingDue:[],reasons:[]},quantities:{revision:'TEST',factoryAttribution:'unknown',lines:[{lineId:'F',demand:4,received:2,inspected:2,qualified:2,packed:2,remainingReceipt:2,remainingShipment:2,qualityGap:0,qualityConflict:false,factoryAttribution:'unknown',reasons:['TEST原收货未能逐厂对应']}]}};
 const before=structuredClone(order.businessProgress.quantities),html=renderToStaticMarkup(createElement(CockpitReceiptSummary,{order}));expect(html).toContain('全单还差实收2件');expect(html).toContain('已收2件尚不能确认来自哪家工厂');expect(html).toContain('原收货记录');expect(order.businessProgress.quantities).toEqual(before);
 order.lines.push({...order.lines[0]!,id:'hidden'});expect(renderToStaticMarkup(createElement(CockpitReceiptSummary,{order}))).toContain('当前可见范围还差实收2件');
});

it('R2-01: removes requirement and adopted-version disclosures while retaining actual quantities and unknown progress',()=>{
 const order=fixture();order.lines=[{id:'F',po:'TEST-F',color:'黑',formalStyleNo:null,temporaryStyleNo:null,orderedQuantity:4}];
 order.businessProgress={ruleVersion:'journey-business-v1',asOf:'2026-11-05T00:00:00Z',requirements:[{id:'TEST-requirement',key:'rework',label:'TEST逐项依据原文',stage:'receiving',scopeRef:'F',applicability:'unknown',completed:false,instanceIds:[],reasons:['TEST不应转移的依据'],targets:[{source:'series_plan',planId:'TEST-plan',revision:9,scopeRef:'F',at:'2026-12-18',precision:'date',retainedFromRevision:8}]}],applicable:4,completed:2,unknown:1,ratio:null,stages:[],plan:{status:'not_adopted',planId:null,revision:null,covered:0,missing:4,due:0,outstandingDue:[],reasons:[]},quantities:{revision:'TEST',factoryAttribution:'unknown',lines:[{lineId:'F',demand:4,received:2,inspected:2,qualified:2,packed:2,remainingReceipt:2,remainingShipment:2,qualityGap:0,qualityConflict:false,factoryAttribution:'unknown',reasons:[]}]}};
 const before=structuredClone(order),full=renderToStaticMarkup(createElement(CockpitBusinessProgress,{order})),compact=renderToStaticMarkup(createElement(CockpitBusinessProgress,{order,compact:true}));
 for(const html of [full,compact]){for(const removed of ['查看进度依据与采用版本','TEST逐项依据原文','TEST不应转移的依据','2026-12-18'])expect(html).not.toContain(removed);expect(html).toContain('还差实收2件');expect(html).not.toContain('role="progressbar"');}
 expect(full).toContain('到仓质检覆盖2件，装箱2件');expect(full).toContain('另1项依据未齐');expect(compact).toContain('2件工厂归属待核');expect(compact).not.toContain('订单实际数量');expect(order).toEqual(before);
});
