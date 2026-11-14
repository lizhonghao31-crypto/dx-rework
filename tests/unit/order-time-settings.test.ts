import {describe,it,expect} from 'vitest';
import {digitalSlaDefaults} from '@dx-rework/contracts/digital-sla';
import {DEVELOPMENT_CYCLE_DEFAULTS} from '@dx-rework/contracts/digital-development-technical';
import {ORDER_TIME_NODES,OrderTimeConfigurationSchema,orderTimeConfigurationFromLegacy,type OrderTimeConfiguration,type OrderTimeCalculation} from '@dx-rework/contracts/order-time-settings';
import {CustomerMerchandisersSaveSchema} from '@dx-rework/contracts/digital-customer-merchandisers';
import {orderTimeSettingsCalculation} from '../../apps/api/src/production-platform/order-time-settings-calculation.js';
import {timeText,beijingInputInstant,beijingLocalInput} from '../../apps/web/src/order-time-settings-model.js';
import {randomUUID} from 'node:crypto';
function configuration():OrderTimeConfiguration{
 const values=orderTimeConfigurationFromLegacy({unified:digitalSlaDefaults(),development:DEVELOPMENT_CYCLE_DEFAULTS,planning:{}});
 for(const node of ORDER_TIME_NODES){const rule=values.nodes[node.key]!;if(rule.kind==='work'||rule.kind==='forecast'||rule.kind==='supervision')values.nodes[node.key]={...rule,minutes:60};}
 return OrderTimeConfigurationSchema.parse(values);
}
const input=(values=configuration()):OrderTimeCalculation=>({values,startAt:'2026-11-02T00:00:00Z',lines:[{id:'TEST-PO1',customerDate:'2026-11-02'}],development:{enabled:true,craftSteps:[],washing:'免洗',accessories:false},bulk:{craftSteps:[],preshrink:false}});
describe('R5 single-time settings and temporary original-graph calculation',()=>{
 it('keeps legacy orders out of conversion and uses one responsibility duration in the explicit new standard',()=>{
  const old={unified:digitalSlaDefaults(),development:{...DEVELOPMENT_CYCLE_DEFAULTS,externalWashDays:9},planning:{development_washing:{minutes:60,calendar:'beijing_sunday_excluded' as const}}};
  const values=orderTimeConfigurationFromLegacy(old);
  expect(values.nodes.development_washing).toMatchObject({kind:'work',minutes:1440,calendar:'beijing_sunday_excluded'});
  expect(old.planning.development_washing.minutes).toBe(60);expect(old.development.externalWashDays).toBe(9);
  expect(Object.hasOwn(values.nodes,'development_print_embroidery')).toBe(false);
 });
 it('calculates13hours on the real serial/parallel path rather than summing all editable definitions',()=>{
  const value=input(),result=orderTimeSettingsCalculation(value).lines[0]!;
  expect(result.totalSpanMinutes).toBe(13*60);expect(result.expectedEnd).toBe('2026-11-02T13:00:00.000Z');expect(result.marginMinutes).toBe(3*60);
  expect(result.rows.find(r=>r.parameterKey==='development_confirmation')?.label).toBe('设计确认');
 });
 it('keeps useful duration and forward arrangement visible without fabricating a missing customer date',()=>{
  const result=orderTimeSettingsCalculation({...input(),lines:[{id:'TEST-PO1',customerDate:null}]}).lines[0]!;
  expect(result.totalSpanMinutes).toBe(13*60);expect(result.marginMinutes).toBeNull();expect(result.rows.find(r=>r.parameterKey==='garment_packing')?.endAt).toBeNull();
 });
 it('adds two actual sequential crafts and their separate QC without adding included handoffs again',()=>{
  const value=input();value.bulk.craftSteps=[{craftKind:'embroidery',sequence:1},{craftKind:'printing',sequence:2}];
  const result=orderTimeSettingsCalculation(value).lines[0]!;
  expect(result.totalSpanMinutes).toBe(17*60);expect(result.rows.filter(r=>r.parameterKey==='bulk_qc')).toHaveLength(2);
  expect(result.rows.some(r=>r.parameterKey==='bulk_print_embroidery')).toBe(false);
 });
 it('does not add supervision, reminder changes or optional redo to actual work duration',()=>{
  const values=configuration();values.nodes.development_cycle_normal={...values.nodes.development_cycle_normal!,minutes:30*1440};
  values.nodes.garment_rework={...values.nodes.garment_rework!,minutes:20*1440};
  for(const node of Object.values(values.nodes))node.reminder={enabled:false,percent:85};
  expect(orderTimeSettingsCalculation(input(values)).lines[0]?.totalSpanMinutes).toBe(13*60);
 });
 it('reports missing real planning input instead of substituting zero',()=>{
  const values=configuration();values.nodes.factory_production_work={...values.nodes.factory_production_work!,minutes:null};
  expect(orderTimeSettingsCalculation(input(values)).lines[0]).toMatchObject({totalSpanMinutes:null,expectedEnd:null,marginMinutes:null});
 });
 it('keeps PO dates independent and retains the actual shortfall',()=>{
  const value={...input(),lines:[{id:'PO1',customerDate:'2026-11-01'},{id:'PO2',customerDate:'2026-11-02'}]},result=orderTimeSettingsCalculation(value).lines;
  expect(result[0]?.marginMinutes).toBe(-21*60);expect(result[1]?.marginMinutes).toBe(3*60);
 });
 it('rejects duplicate PO identities and invalid dates',()=>{
  expect(()=>orderTimeSettingsCalculation({...input(),lines:[{id:'PO1',customerDate:'2026-02-30'}]})).toThrow('有效客户交期');
  expect(()=>orderTimeSettingsCalculation({...input(),lines:[{id:'PO1',customerDate:null},{id:'PO1',customerDate:null}]})).toThrow('不同的PO');
 });
 it('keeps Beijing input explicit and does not floor a sub-day shortage to zero days',()=>{
  expect(beijingInputInstant('2026-11-02T08:00')).toBe('2026-11-02T00:00:00.000Z');expect(beijingLocalInput('2026-11-02T00:00:00Z')).toBe('2026-11-02T08:00');expect(timeText(30)).toBe('30分钟');expect(timeText(1500)).toBe('1天1小时');
 });
});
describe('R5 explicit customer batch arrangements',()=>{
 it('requires one primary, permits multiple secondary users and requires append or replace',()=>{
  const primary=randomUUID(),secondary=[randomUUID(),randomUUID()],base={customers:[{code:'TEST A',expectedVersion:0}],primaryMerchandiserId:primary,secondaryMerchandiserIds:secondary,mode:'append'};
  expect(CustomerMerchandisersSaveSchema.parse(base).secondaryMerchandiserIds).toEqual(secondary);
  expect(CustomerMerchandisersSaveSchema.safeParse({...base,primaryMerchandiserId:null}).success).toBe(false);
  expect(CustomerMerchandisersSaveSchema.safeParse({...base,mode:undefined}).success).toBe(false);
  expect(CustomerMerchandisersSaveSchema.safeParse({...base,secondaryMerchandiserIds:[primary]}).success).toBe(false);
  expect(CustomerMerchandisersSaveSchema.safeParse({...base,secondaryMerchandiserIds:[secondary[0],secondary[0]]}).success).toBe(false);
 });
});

it('renders duration without long decimal minutes while preserving a positive remainder',()=>{expect(timeText(19*1440+13*60+51.7746)).toBe('19天13小时52分钟');expect(timeText(59.99)).toBe('1小时');expect(timeText(0.001)).toBe('不足1分钟');expect(timeText(0)).toBe('0小时');});
