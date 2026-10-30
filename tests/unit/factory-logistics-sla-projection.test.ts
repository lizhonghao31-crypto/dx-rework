import {expect,it} from 'vitest';
import type {FactoryReturnLogisticsWindow} from '@dx-rework/contracts/factory-flow';
import {evaluateSlaPlan,type SlaPlan} from '@dx-rework/domain/digital-sla-plan';
import {attachFactoryLogisticsRanges} from '../../apps/api/src/production-platform/factory-logistics-sla-projection.js';
import {logisticsRangeLabel} from '../../apps/web/src/journey-sla-details.js';
const plan:SlaPlan={nodes:['one','two'].map(id=>({id:`return_logistics:${id}`,label:'物流',parameterKey:'return_logistics',stage:7,kind:'estimate',minutes:2880,offsetDays:null,dependsOn:[],anchorKey:`dispatch:${id}`,targetKey:null,includedIn:null,includedPosition:'start',applicable:'yes',countsProgress:true})),anchors:{},warningPercent:70,stageBufferMinutes:0};
const window=(productionId='native-one',factoryDecisionId:string|null=null):FactoryReturnLogisticsWindow=>({productionId,factoryDecisionId,supplierName:'TEST factory',shippedOn:'2026-12-06',dispatchPrecision:'date',actualDispatchedAt:null,estimatedMinutes:2880,arrivalRange:{fromInclusive:'2026-12-07T16:00:00.000Z',toExclusive:'2026-12-08T16:00:00.000Z'},estimateExpired:false,evidence:`shipment:${productionId}:${factoryDecisionId}`,firstReceivedAt:null,snapshotId:'frozen'});
it('joins exact native execution and PO identities without sharing a shipment with another line or factory',()=>{
 const nodes=evaluateSlaPlan(plan,{}, {now:'2026-12-06T05:00:00.000Z',scenarioId:null,revision:0}),before=structuredClone(nodes),windows=[window(),window('native-one','transfer'),window('unrelated')];
 const result=attachFactoryLogisticsRanges(nodes,plan,windows,[{productionId:'native-one',factoryDecisionId:null,lineId:'one'},{productionId:'native-one',factoryDecisionId:'transfer',lineId:'two'}]);
 expect(result[0]!.logisticsWindows).toEqual([windows[0]]);expect(result[1]!.logisticsWindows).toEqual([windows[1]]);expect(nodes).toEqual(before);
 for(const [i,node] of result.entries()){const {logisticsWindows,...precise}=node;expect(precise).toEqual(before[i]);expect(logisticsWindows).toHaveLength(1);expect(node.actualStart).toBeNull();expect(node.deadline.at).toBeNull();}
});
it('does not add ranges without native attribution or overwrite a completed assessment',()=>{
 const time={now:'2026-12-10T05:00:00.000Z',scenarioId:null,revision:0},nodes=evaluateSlaPlan(plan,{'return_logistics:one':{evidence:'original completion',completedAt:'2026-12-09T05:00:00.000Z',completedDeadline:{at:null,exclusive:false,reasons:['date-only original']}}},time);
 expect(attachFactoryLogisticsRanges(nodes,plan,[window()],[])).toEqual(nodes);
 const result=attachFactoryLogisticsRanges(nodes,plan,[{...window(),estimateExpired:true}],[{productionId:'native-one',factoryDecisionId:null,lineId:'one'}]);
 expect(result[0]).toMatchObject({status:'completed_unrated',actualEnd:nodes[0]!.actualEnd,deadline:nodes[0]!.deadline,forecast:nodes[0]!.forecast});
 expect(result[1]!.logisticsWindows).toBeUndefined();
});
it('keeps range endpoints, milliseconds and exclusive end explicit in Beijing display',()=>{
 expect(logisticsRangeLabel({fromInclusive:'2026-12-07T16:00:00.001Z',toExclusive:'2026-12-08T16:00:00.001Z'})).toBe('2026-12-08 00:00:00.001（含）至 2026-12-09 00:00:00.001（不含），北京时间');
});
