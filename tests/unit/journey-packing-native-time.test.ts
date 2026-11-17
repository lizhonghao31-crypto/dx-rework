import {describe,expect,it} from 'vitest';
import type {JourneyNode,OrderJourney} from '@dx-rework/contracts/digital-production-journey';
import type {OrderClosureSheet} from '@dx-rework/contracts/order-closure';
import type {SlaNodeFact} from '@dx-rework/domain/digital-sla-plan';
import {attachJourneyPackingTime} from '../../apps/api/src/production-platform/journey-native-times.js';
const at=(hours:number)=>new Date(Date.parse('2026-11-15T00:00:00.000Z')+hours*3600000).toISOString();
function fixture(){
 const node={key:'packing',instanceId:'packing:0',current:true,state:'active',records:[{domain:'closure',id:'TEST-order',lineId:null}]} as JourneyNode;
 const qc={key:'factory_production_qc',instanceId:'TEST-qc',current:true,state:'active',records:[],actualAt:null} as JourneyNode;
 const item={orderId:'TEST-order',stages:[{nodes:[node,qc]}]} as OrderJourney;
 const sheet={orderId:'TEST-order',stage:'等待回货与装箱',lines:[{lineId:'one'},{lineId:'two'}]} as OrderClosureSheet;
 const facts:Record<string,SlaNodeFact>=Object.fromEntries(['one','two'].map((line,index)=>[`garment_packing:${line}`,{evidence:`packing:TEST-${line}:original-physical-A`,businessCompleted:true,startedAt:at(index),completedAt:at(4+index)}]));
 return {node,qc,item,sheet,facts};
}
describe('exact packing physical completion projection',()=>{
 it('uses the final covered physical A while QC/financial closure and unrelated nodes remain open',()=>{
  const {node,qc,item,sheet,facts}=fixture(),before=structuredClone(facts);
  attachJourneyPackingTime(item,sheet,facts,at(8));
  expect(node).toMatchObject({state:'completed',sla:'finished',actualAt:at(5),completesOrder:false});expect(qc).toMatchObject({state:'active',actualAt:null});expect(facts).toEqual(before);
  sheet.stage='本期装箱完成';attachJourneyPackingTime(item,sheet,facts,at(80));expect(node).toMatchObject({actualAt:at(5),completesOrder:true});
 });
 it.each(['missing','future','before-ready','incomplete','other-order'])('never invents A for %s evidence',mode=>{
  const {node,item,sheet,facts}=fixture();
  if(mode==='missing')delete facts['garment_packing:two']!.completedAt;
  if(mode==='future')facts['garment_packing:two']!.completedAt=at(9);
  if(mode==='before-ready')facts['garment_packing:two']!.startedAt=at(6);
  if(mode==='incomplete')facts['garment_packing:two']!.businessCompleted=false;
  if(mode==='other-order')sheet.orderId='TEST-other';
  attachJourneyPackingTime(item,sheet,facts,at(8));expect(node.state).toBe('active');expect(node.actualAt??null).toBeNull();
 });
 it('does not require a known R/D to retain a true A, and never promotes partial PO scope to whole-order completion',()=>{
  const {node,item,sheet,facts}=fixture();for(const fact of Object.values(facts))delete fact.startedAt;
  node.records[0]!.lineId='one';sheet.stage='本期装箱完成';attachJourneyPackingTime(item,sheet,facts,at(8));
  expect(node).toMatchObject({state:'completed',actualAt:at(4),completesOrder:false});
 });
 it('retains a date-only physical A as a date rather than discarding it or inventing midnight',()=>{
  const {node,item,sheet,facts}=fixture();delete facts['garment_packing:two']!.completedAt;facts['garment_packing:two']!.completedDate='2026-11-15';
  attachJourneyPackingTime(item,sheet,facts,at(8));expect(node).toMatchObject({state:'completed',actualAt:null,actualDate:'2026-11-15',sla:'finished',completesOrder:false});
 });
});
