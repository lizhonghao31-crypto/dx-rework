import {describe,it,expect} from 'vitest';
import {digitalSlaDefaults} from '@dx-rework/contracts/digital-sla';
import {DEVELOPMENT_CYCLE_DEFAULTS} from '@dx-rework/contracts/digital-development-technical';
import type {SlaCalculationContext} from '@dx-rework/contracts/sla-calculation';
import {buildSlaCalculationRoute} from '@dx-rework/domain/sla-calculation-routes';
import {settingsCalculation,settingsStandardTimes} from '../../apps/web/src/sla-calculation-preview-model.js';
import {readableSlaMinutes,slaInputValue,slaDraftErrors,developmentDraftErrors,type SlaDraftSnapshot} from '../../apps/web/src/sla-settings-draft.js';
const origin='2026-11-02T00:00:00.000Z',reference={precision:'instant' as const,value:origin,source:'TEST explicit reference, no live snapshot'};
const context=(range:'preparation'|'development'='preparation'):SlaCalculationContext=>{
 const values=digitalSlaDefaults(),development={...DEVELOPMENT_CYCLE_DEFAULTS},conditions={craft:'printing' as const,craftExecution:'internal' as const,pattern:'internal' as const,washing:'none' as const,preshrink:'yes' as const,preparation:'adopted' as const,developmentMode:'normal' as const,rework:'no' as const},references={development_published:reference,instruction_published:reference,whole_fabric_arrived:reference};
 return {selection:{mode:'example',range,conditions,references},identity:{kind:'example',id:null,sourceId:null,orderId:null,round:null,label:'TEST rules'},unified:{version:7,values},development:{version:1,values:development},graph:buildSlaCalculationRoute({range,conditions,anchors:references,values,unifiedSource:'TEST named unified values, not a live UUID',development,developmentSource:'TEST development values'}),bindings:{},limitations:[]};
};
const draft=(c:SlaCalculationContext):SlaDraftSnapshot<typeof c.unified.values>=>({version:c.unified.version,current:c.unified.values,values:structuredClone(c.unified.values),errors:{},publishedVersion:null,readOnly:false});
describe('M01 real settings draft model',()=>{
 it('overlays only fields changed from the editor baseline after the server publishes a newer unified or development standard',()=>{
  const older=context('development'),snapshot=draft(older),development={version:1,current:{...DEVELOPMENT_CYCLE_DEFAULTS},values:{...DEVELOPMENT_CYCLE_DEFAULTS},errors:{},publishedVersion:null,readOnly:false};
  const newer=context('development');newer.unified.version=8;newer.unified.values.development_pattern={kind:'duration',minutes:2160};newer.development.version=2;newer.development.values={...DEVELOPMENT_CYCLE_DEFAULTS,normalDays:9};newer.graph=buildSlaCalculationRoute({range:'development',conditions:{craft:'printing',craftExecution:'internal',pattern:'internal',washing:'none',preshrink:'yes',preparation:'adopted',developmentMode:'normal',rework:'no'},anchors:newer.graph.anchors,values:newer.unified.values,development:newer.development.values,unifiedSource:'TEST newer standard',developmentSource:'TEST newer cycle'});
  snapshot.values.development_tail_check={kind:'duration',minutes:15};const result=settingsCalculation(newer,snapshot,development);expect(result.result.rows.find(row=>row.id==='development_pattern')!.minutes).toBe(2160);expect(result.result.rows.find(row=>row.id==='development_cycle')!.minutes).toBe(9*1440);expect(result.result.rows.find(row=>row.id==='development_tail_check')!.minutes).toBe(15);
  const frozen=newer.graph.nodes.find(node=>node.id==='development_pattern')!;frozen.minutes=3000;frozen.source='TEST actual old instance freeze';expect(settingsCalculation(newer,snapshot,development).result.rows.find(row=>row.id==='development_pattern')!.minutes).toBe(3000);
 });
 it('keeps empty and intermediate text invalid while zero buffer remains a real permitted zero',()=>{
  for(const text of ['',' ','-','.','1e'])expect(slaInputValue(text,'minutes',{kind:'duration',minutes:60})).toMatchObject({value:null,error:expect.any(String)});
  expect(slaInputValue('0','minutes',{kind:'buffer',minutes:5})).toMatchObject({value:{kind:'buffer',minutes:0},error:null});expect(slaInputValue('0','hours',{kind:'duration',minutes:60}).value).toBeNull();
 });
 it('preserves duration units and exact three-to-six millisecond values without display rounding changing data',()=>{
  expect(slaInputValue('1.5','days-duration',{kind:'duration',minutes:60}).value).toEqual({kind:'duration',minutes:2160});
  for(const [raw,label]of [['0.00005','3毫秒'],['0.0001','6毫秒']]){const parsed=slaInputValue(raw!,'minutes',{kind:'duration',minutes:1});expect(parsed.error).toBeNull();expect(parsed.value&&'minutes'in parsed.value?readableSlaMinutes(parsed.value.minutes):'invalid').toBe(label);}
  expect(slaInputValue('0.00000001','minutes',{kind:'duration',minutes:1}).value).toBeNull();
 });
 it('keeps the known parallel branch when invalid preshrink input blocks only its real merge',()=>{
  const c=context(),s=draft(c);s.errors.warehouse_preshrink='必做预缩输入尚未完整';const result=settingsCalculation(c,s,null);
  expect(result.result.overall.spanMs).toBeNull();expect(result.result.overall.knownBranches).toEqual(expect.arrayContaining([expect.objectContaining({id:'bulk_pattern',spanMs:48*3600000})]));expect(result.result.rows.find(n=>n.id==='fabric_inspection')!.end.at).toBe('2026-11-03T00:00:00.000Z');expect(result.result.rows.find(n=>n.id==='warehouse_preshrink')!.end.at).toBeNull();
 });
 it('recomputes preparation 60 to48 to48 hours on the exact shared model and recovers after invalid input',()=>{
  const c=context(),s=draft(c);expect(settingsCalculation(c,s,null).result.overall.spanMs).toBe(60*3600000);s.values.warehouse_preshrink={kind:'duration',minutes:1440};expect(settingsCalculation(c,s,null).result.overall.spanMs).toBe(48*3600000);s.values.warehouse_preshrink={kind:'duration',minutes:720};expect(settingsCalculation(c,s,null).result.overall.spanMs).toBe(48*3600000);s.errors.warehouse_preshrink='空白';expect(settingsCalculation(c,s,null).result.overall.spanMs).toBeNull();s.errors={};s.values=structuredClone(c.unified.values);expect(settingsCalculation(c,s,null).result.overall.spanMs).toBe(60*3600000);
 });
 it('does not replace frozen included targets or throw away independent evidence when a hypothetical parent cannot fit',()=>{
  const c=context('development'),s=draft(c);for(const node of c.graph.nodes.filter(n=>n.kind==='included'&&n.includedIn==='development_printing'))node.minutes=60;
  s.values.development_printing={kind:'duration',minutes:90};const result=settingsCalculation(c,s,null);expect(result.errors.join(' ')).toContain('内含目标');expect(result.result.rows.find(n=>n.id==='development_printing')!.end.at).toBeNull();expect(result.result.rows.find(n=>n.id==='development_cycle')!.end.at).toBe('2026-11-09T00:00:00.000Z');expect(result.result.rows.find(n=>n.id==='development_materials')!.end.at).toBe('2026-11-02T04:00:00.000Z');
 });
 it('locates a globally excessive included sum at its parent and child inputs',()=>{
  const values=digitalSlaDefaults();values.development_printing={kind:'duration',minutes:45};const errors=slaDraftErrors(values);expect(errors.development_printing).toContain('超过');expect(errors.development_craft_dispatch).toContain('超过');expect(errors.development_craft_return).toContain('超过');
 });
 it('keeps development integer-day and approved urgent-versus-normal boundaries separate from unified hours',()=>{
  expect(developmentDraftErrors({...DEVELOPMENT_CYCLE_DEFAULTS,normalDays:7.5})).toHaveProperty('normalDays');expect(Object.keys(developmentDraftErrors({...DEVELOPMENT_CYCLE_DEFAULTS,urgentDays:8})).length).toBeGreaterThan(0);expect(developmentDraftErrors({...DEVELOPMENT_CYCLE_DEFAULTS})).toEqual({});
 });
 it('never fills a missing example reference with today or reports an independent completed total',()=>{
  const c=context();c.graph.anchors={};const result=settingsCalculation(c,draft(c),null);expect(result.result.overall.spanMs).toBeNull();expect(result.result.overall.start.at).toBeNull();expect(result.result.rows.every(n=>!n.start.at&&!n.end.at)).toBe(true);
 });
});

it('R3-04 displays genuine relative standard paths without inventing an absolute start, total or live instance facts',()=>{
 const c=context('development');c.graph.anchors={};const before=structuredClone(c.graph),calculated=settingsCalculation(c,draft(c),null),display=settingsStandardTimes(calculated.graph,calculated.result);
 expect(calculated.result.overall.start.at).toBeNull();expect(calculated.result.overall.end.at).toBeNull();// Original printing route: clerk4 + pattern48 + cutting4 + craft96 + sewing24 + tail0.5 hours.
 expect(display.overallMs).toBe(176.5*3600000);expect(display.stages.find(row=>row.stage===2)?.spanMs).toBe(176.5*3600000);expect(c.graph).toEqual(before);
 c.graph.observationMode='instance';const frozen=settingsCalculation(c,draft(c),null),instance=settingsStandardTimes(frozen.graph,frozen.result);expect(instance.overallMs).toBeNull();expect(instance.knownPathMs).toBeNull();expect(instance.stages.every(stage=>stage.spanMs===null)).toBe(true);
});
it('R3-04 whole standard view retains unknown actual-event gates but directly displays its calculable development path',()=>{
 const c=context('development'),conditions=c.selection.mode==='example'?c.selection.conditions:null;if(!conditions)throw Error('TEST original example required');
 c.graph=buildSlaCalculationRoute({range:'whole',conditions,anchors:{},values:c.unified.values,development:c.development.values,unifiedSource:'TEST actual existing defaults',developmentSource:'TEST actual existing independent defaults'});
 const raw=settingsCalculation(c,draft(c),null),view=settingsStandardTimes(raw.graph,raw.result);expect(view.overallMs).toBeNull();expect(view.knownPathMs).toBeGreaterThan(0);expect(view.stages.find(stage=>stage.stage===2)).toMatchObject({spanMs:null,partial:true,knownPathMs:expect.any(Number)});expect(Object.keys(c.graph.anchors)).toEqual([]);expect(raw.result.rows.every(row=>row.start.at===null&&row.end.at===null)).toBe(true);
});
