import {describe,it,expect} from 'vitest';
import {digitalSlaDefaults} from '../../packages/contracts/src/digital-sla.js';
import {DEVELOPMENT_CYCLE_DEFAULTS} from '../../packages/contracts/src/digital-development-technical.js';
import {SlaCalculationPreviewSchema,type CalculationGraph,type CalculationNode,type SlaCalculationConditions} from '../../packages/contracts/src/sla-calculation.js';
import {calculateSlaPreview,calculationDraftGraph,addCalculationMinutes,SlaCalculationInputError} from '../../packages/domain/src/sla-calculation.js';
import {buildSlaCalculationRoute,type CalculationRouteInput} from '../../packages/domain/src/sla-calculation-routes.js';
import {calculateSlaPlan} from '../../packages/domain/src/digital-sla-plan.js';
import {slaCalculationDigest} from '../../apps/api/src/production-platform/sla-calculation-service.js';
import {calculateDevelopmentCycle} from '../../packages/domain/src/development-cycle.js';

const t0='2026-11-02T00:00:00.000Z',hour=3600000;
const at=(h:number)=>new Date(Date.parse(t0)+h*hour).toISOString();
const anchor=(h=0)=>({precision:'instant' as const,value:at(h),source:'TEST explicit reference'});
const node=(id:string,minutes:number,extra:Partial<CalculationNode>={}):CalculationNode=>({id,label:id,stage:1,parameterKey:id,applicable:'yes',countsProgress:false,kind:'duration',minutes,offsetDays:null,dependsOn:[],anchorKey:'t0',targetKey:null,includedIn:null,includedPosition:'start',calendar:'continuous',source:'TEST standard',binding:null,...extra});
const graph=(nodes:CalculationNode[],endIds=[nodes.at(-1)!.id]):CalculationGraph=>({observationMode:'example',nodes,anchors:{t0:anchor()},warningPercent:70,stageBufferMinutes:0,endIds,rangeLabel:'TEST bounded range',startLabel:'TEST explicit start',endLabel:'TEST selected end'});
const row=(r:ReturnType<typeof calculateSlaPreview>,id:string)=>r.rows.find(n=>n.id===id)!;
const conditions:SlaCalculationConditions={craft:'none',craftExecution:'internal',pattern:'internal',washing:'none',preshrink:'yes',preparation:'adopted',developmentMode:'normal',rework:'no'};
const route=(range:CalculationRouteInput['range'],extra:Partial<CalculationRouteInput>={})=>buildSlaCalculationRoute({range,conditions,values:digitalSlaDefaults(),unifiedSource:'TEST named v7 values, not a live snapshot',development:{...DEVELOPMENT_CYCLE_DEFAULTS},developmentSource:'TEST independent v1',anchors:{development_published:anchor(),instruction_published:anchor(),whole_fabric_arrived:anchor(),cut_craft_dispatched:anchor(),sourcing_decided:anchor()},...extra});
describe('M01 shared standard-window calculation',()=>{
 it('reuses legacy topology validation and leaves the original continuous calculator unchanged',()=>{
  const p=graph([node('a',240),node('b',2880,{anchorKey:null,dependsOn:['a']}),node('c',120,{anchorKey:null,dependsOn:['b']})]);
  expect(calculateSlaPlan(p).at(-1)!.end.at).toBe(at(54));
  expect(calculateSlaPreview(p).overall.spanMs).toBe(54*hour);
  expect(calculateSlaPlan(p).at(-1)!.end.at).toBe(at(54));
 });
 it('E1 serial 54h becomes 42h without mutating inputs',()=>{
  const p=graph([node('a',240),node('b',2880,{anchorKey:null,dependsOn:['a']}),node('c',120,{anchorKey:null,dependsOn:['b']})]);
  expect(calculateSlaPreview(p).overall.spanMs).toBe(54*hour);p.nodes[1]!.minutes=2160;
  const before=JSON.stringify(p);expect(calculateSlaPreview(p).overall.spanMs).toBe(42*hour);expect(JSON.stringify(p)).toBe(before);
 });
 it('E2 parallel max, unchanged non-determining branch and every equal determining path',()=>{
  const p=graph([node('a',240),node('b',2880,{anchorKey:null,dependsOn:['a']}),node('c',1440,{anchorKey:null,dependsOn:['a']}),node('d',120,{anchorKey:null,dependsOn:['b','c']})]);
  expect(calculateSlaPreview(p).overall.spanMs).toBe(54*hour);p.nodes[2]!.minutes=1800;expect(calculateSlaPreview(p).overall.spanMs).toBe(54*hour);
  p.nodes[1]!.minutes=1800;const tied=calculateSlaPreview(p);expect(tied.overall.spanMs).toBe(36*hour);expect(row(tied,'d').determiningPredecessors).toEqual(['b','c']);expect(tied.overall.determiningNodes).toEqual(['a','b','c','d']);
 });
 it('E3 included 30-minute handoffs stay inside 96h, including their accurate displayed times',()=>{
  const p=graph([node('parent',5760),node('out',30,{kind:'included',includedIn:'parent',anchorKey:null}),node('back',30,{kind:'included',includedIn:'parent',includedPosition:'end',anchorKey:null})],['parent']);
  const r=calculateSlaPreview(p);expect(r.overall.spanMs).toBe(96*hour);expect(row(r,'out').end.at).toBe(at(.5));expect(row(r,'back').start.at).toBe(at(95.5));expect(row(r,'back').end.at).toBe(at(96));
 });
 it('E5 stage spans overlap and are never summed into the overall result',()=>{
  const p=graph([node('a',240),node('b',2880,{stage:2,dependsOn:['a'],anchorKey:null}),node('c',1440,{dependsOn:['a'],anchorKey:null}),node('d',120,{stage:3,dependsOn:['b','c'],anchorKey:null})]);
  const r=calculateSlaPreview(p);expect(r.stages.map(s=>s.spanMs)).toEqual([28*hour,48*hour,2*hour]);expect(r.overall.spanMs).toBe(54*hour);
  p.stageBufferMinutes=60;expect(calculateSlaPreview(p).overall.spanMs).toBe(56*hour);
 });
 it('E9 unknown required wait blocks the merge while the known 28h branch remains available',()=>{
  const p=graph([node('a',240),node('b',1440,{dependsOn:['a'],anchorKey:null}),node('customer',0,{kind:'unlimited',minutes:null}),node('merge',60,{dependsOn:['b','customer'],anchorKey:null})]);
  const r=calculateSlaPreview(p);expect(r.overall.status).toBe('partial');expect(r.overall.spanMs).toBeNull();expect(r.overall.knownBranches.find(b=>b.id==='b')!.spanMs).toBe(28*hour);expect(r.overall.missing.join(' ')).toContain('没有固定时长');
 });
 it('missing origin is not replaced by the first known inner-node start or today',()=>{
  const p=graph([node('a',60,{anchorKey:'missing',completedAt:anchor(4)}),node('b',60,{dependsOn:['a'],anchorKey:null})]);
  const r=calculateSlaPreview(p);expect(row(r,'b').end.at).toBe(at(5));expect(r.overall.status).toBe('partial');expect(r.overall.spanMs).toBeNull();
 });
 it('a date-only start never silently becomes midnight or a current instant',()=>{
  const p=graph([node('a',60)]);p.anchors.t0={precision:'date',value:'2026-11-02',source:'TEST only a day'};const r=calculateSlaPreview(p);expect(r.overall.spanMs).toBeNull();expect(row(r,'a').start.reasons.join(' ')).toContain('只有日期');
 });
 it('preserves an early actual completion without clamping a contradictory range to a successful zero span',()=>{
  const p=graph([node('a',60,{completedAt:anchor(-1)})]);p.observationMode='instance';const r=calculateSlaPreview(p);expect(row(r,'a').end.at).toBe(at(-1));expect(r.overall.spanMs).toBeNull();expect(r.overall.status).toBe('partial');expect(r.overall.missing.join(' ')).toContain('早于');
 });
 it('E13 an early target is visible but cannot stand in for completion of its predecessor',()=>{
  const p=graph([node('prior',1920),node('factory',0,{kind:'order_date',minutes:null,targetKey:'target',dependsOn:['prior'],anchorKey:null}),node('next',1440,{dependsOn:['factory'],anchorKey:null})]);
  p.anchors.t0={precision:'instant',value:'2026-11-10T00:00:00+08:00',source:'TEST explicit reference'};p.anchors.target={precision:'date',value:'2026-11-10',source:'TEST target day'};
  const r=calculateSlaPreview(p);expect(row(r,'prior').end.at).toBe('2026-11-11T00:00:00.000Z');expect(row(r,'factory').target).toMatchObject({at:'2026-11-10T16:00:00.000Z',exclusive:true});expect(row(r,'next').end.at).toBeNull();
  p.nodes[1]!.completedAt={precision:'instant',value:'2026-11-11T08:00:00+08:00',source:'TEST actual explicit completion'};expect(row(calculateSlaPreview(p),'next').end.at).toBe('2026-11-12T00:00:00.000Z');
 });
 it('P05-14 retains 3ms→6ms and a 3ms serial difference',()=>{
  const p=graph([node('a',.00005),node('b',60,{dependsOn:['a'],anchorKey:null})]);const first=calculateSlaPreview(p);expect(row(first,'a').end.at).toBe('2026-11-02T00:00:00.003Z');p.nodes[0]!.minutes=.0001;expect(calculateSlaPreview(p).overall.spanMs!-first.overall.spanMs!).toBe(3);
 });
 it.each([0,-1,NaN,Infinity,525601,.00000001])('rejects invalid duration %s instead of converting it to 0',(minutes)=>{expect(()=>calculateSlaPreview(graph([node('a',minutes)]))).toThrow();});
 it('locates an invalid field by its actual parameter instead of returning only a generic arithmetic failure',()=>{try{calculateSlaPreview(graph([node('paper',0,{label:'开发纸样',parameterKey:'development_pattern'})]));throw Error('Expected invalid field');}catch(error){expect(error).toBeInstanceOf(SlaCalculationInputError);expect(error).toMatchObject({field:'development_pattern.minutes',message:expect.stringContaining('开发纸样')});}});
 it.each(['cycle','duplicate','edge','missing','included','oversized'] as const)('rejects the %s topology boundary',(mode)=>{
  const p=graph([node('a',60),node('b',60,{dependsOn:['a'],anchorKey:null})]);
  if(mode==='cycle')p.nodes[0]!.dependsOn=['b'];if(mode==='duplicate')p.nodes.push(node('a',60));if(mode==='edge')p.nodes[1]!.dependsOn=['a','a'];if(mode==='missing')p.nodes[1]!.dependsOn=['missing'];
  if(mode==='included'){p.nodes.push(node('child',30,{kind:'included',includedIn:'a'}));p.nodes[1]!.dependsOn=['child'];}if(mode==='oversized')p.nodes.push(node('child',61,{kind:'included',includedIn:'a'}));expect(()=>calculateSlaPreview(p)).toThrow();
 });
 it('is deterministic under node and dependency permutation, without losing tie identities',()=>{
  const p=graph([node('a',60),node('b',60),node('end',60,{dependsOn:['a','b'],anchorKey:null})]);const expected=calculateSlaPreview(p);p.nodes.reverse();p.nodes[0]!.dependsOn.reverse();expect(calculateSlaPreview(p)).toEqual(expected);
 });
 it.each([
  ['2026-11-06T00:00:00+08:00','2026-11-08T16:00:00.000Z'],
  ['2026-11-06T10:00:00+08:00','2026-11-09T02:00:00.000Z'],
  ['2026-11-08T00:00:00+08:00','2026-11-10T16:00:00.000Z'],
  ['2026-12-31T23:59:59.997+08:00','2027-01-02T15:59:59.997Z'],
 ])('E10 business calendar from %s matches Sunday-first endpoint semantics',(start,expected)=>{expect(addCalculationMinutes(start,2880,'beijing_sunday_excluded')).toBe(expected);});
 it('continuous and natural-day calendars keep milliseconds and explicit timezone offsets',()=>{expect(addCalculationMinutes('2026-11-06T10:00:00.003+08:00',2880)).toBe('2026-11-08T02:00:00.003Z');expect(addCalculationMinutes(t0,1440,'natural_days')).toBe(at(24));expect(()=>addCalculationMinutes('2026-02-30T10:00:00Z',60)).toThrow();});
});

describe('first supported real-rule route matrix (TEST reference conditions, no live orders)',()=>{
 it('E11 reuses the native union of 09–11 and 10–12 external intervals, keeping the internal deadline independent',()=>{
  const actual=calculateDevelopmentCycle({publishedAt:t0,completedAt:null,now:at(12),allowedDays:7,warningRatio:.7,intervals:[{id:'TEST-a',departedAt:at(9),returnedAt:at(11),credible:true,closed:true},{id:'TEST-b',departedAt:at(10),returnedAt:at(12),credible:true,closed:true}]});expect(actual.excludedSeconds).toBe(3*3600);
  const p=route('development');p.nodes.find(n=>n.id==='development_cycle')!.exclusion={knownMs:actual.excludedSeconds*1000,reasons:[]};const r=calculateSlaPreview(p);expect(row(r,'development_cycle').end.at).toBe(at(171));expect(r.overall.spanMs).toBe(80.5*hour);
  p.nodes.find(n=>n.id==='development_cycle')!.exclusion={knownMs:null,reasons:['真实外发仍进行中']};expect(row(calculateSlaPreview(p),'development_cycle').end.at).toBeNull();
 });
 it('native contract readiness remains a separate prerequisite without becoming an extra 48h production duration',()=>{
  const p=route('bulk_craft',{conditions:{...conditions,craft:'printing'},requireContractReady:true});expect(calculateSlaPreview(p).overall.spanMs).toBeNull();const refreshed=route('bulk_craft',{conditions:{...conditions,craft:'printing'},requireContractReady:true,anchors:{...p.anchors,contract_pdf_ready:anchor(150)}}),r=calculateSlaPreview(refreshed);expect(r.overall.spanMs).toBe(174*hour);expect(r.rows.some(n=>n.id==='contract_return')).toBe(false);
 });
 it('R1 has 80.5h→68.5h, included transfer, separate 7/5-day supervision and final-comment review',()=>{
  const p=route('development'),values=digitalSlaDefaults(),changed=digitalSlaDefaults();changed.development_pattern={kind:'duration',minutes:2160};
  const r=calculateSlaPreview(p),d=calculateSlaPreview(calculationDraftGraph(p,{unified:values,development:{...DEVELOPMENT_CYCLE_DEFAULTS}},{unified:changed,development:{...DEVELOPMENT_CYCLE_DEFAULTS}}));
  expect(r.overall.spanMs).toBe(80.5*hour);expect(d.overall.spanMs).toBe(68.5*hour);expect(row(r,'development_cycle').minutes).toBe(7*1440);expect(row(r,'development_cycle').independent).toBe(true);expect(row(r,'final_comment_review').minutes).toBe(1440);expect(row(r,'final_comment_review').end.at).toBeNull();
 });
 it.each(['printing','embroidery','print_embroidery'] as const)('supports internal and external %s without adding their supervision window',(craft)=>{
  for(const execution of ['internal','external'] as const){const p=route('development',{conditions:{...conditions,craft,craftExecution:execution,pattern:'external'},anchors:{development_published:anchor(),external_pattern_requested:anchor(2)}}),r=calculateSlaPreview(p);expect(row(r,`development_${craft}`).minutes).toBe(craft==='print_embroidery'?10080:5760);expect(row(r,'external_pattern').end.at).toBe(at(50));expect(row(r,'external_pattern').independent).toBe(true);expect(r.overall.spanMs).toBe((80.5+(craft==='print_embroidery'?168:96))*hour);}
 });
 it('unknown craft remains unknown and never masquerades as the no-craft route',()=>{expect(calculateSlaPreview(route('development',{conditions:{...conditions,craft:'unknown'}})).overall.spanMs).toBeNull();});
 it('reads an existing external washing rule separately from the global 24h frozen value',()=>{const r=calculateSlaPreview(route('development',{conditions:{...conditions,washing:'external'}}));expect(row(r,'development_washing').minutes).toBe(4320);expect(row(r,'development_washing').source).toBe('TEST independent v1');expect(r.overall.spanMs).toBe(153*hour);});
 it('a legal partial repeat route runs only its recreated sewing/tail nodes, not a fake first round',()=>{
  const r=calculateSlaPreview(route('development',{routeKinds:['development_sewing','development_tail_check','development_confirmation']}));expect(r.rows.some(n=>n.id==='development_pattern')).toBe(false);expect(r.overall.spanMs).toBe(24.5*hour);
 });
 it('R2 follows 60→48→48h and switches from fabric to tied paths to pattern',()=>{
  const p=route('preparation'),current={unified:digitalSlaDefaults(),development:{...DEVELOPMENT_CYCLE_DEFAULTS}};
  expect(calculateSlaPreview(p).overall.spanMs).toBe(60*hour);
  const next=digitalSlaDefaults();next.warehouse_preshrink={kind:'duration',minutes:1440};const tied=calculateSlaPreview(calculationDraftGraph(p,current,{...current,unified:next}));expect(tied.overall.spanMs).toBe(48*hour);expect(tied.overall.determiningNodes).toEqual(['bulk_pattern','fabric_inspection','warehouse_preshrink']);
  next.warehouse_preshrink={kind:'duration',minutes:720};const last=calculateSlaPreview(calculationDraftGraph(p,current,{...current,unified:next}));expect(last.overall.spanMs).toBe(48*hour);expect(last.overall.determiningNodes).toEqual(['bulk_pattern']);
 });
 it('E4 no-preshrink route reconnects to inspection and unknown applicability never becomes 24h',()=>{
  const r=calculateSlaPreview(route('preparation',{conditions:{...conditions,preshrink:'no'}}));expect(r.rows.some(n=>n.id==='warehouse_preshrink')).toBe(false);expect(r.overall.spanMs).toBe(48*hour);expect(calculateSlaPreview(route('preparation',{conditions:{...conditions,preshrink:'unknown'}})).overall.spanMs).toBeNull();
 });
 it('E7 keeps separate draft/final anchors, 36h covered interval and no legacy 72h added',()=>{
  const r=calculateSlaPreview(route('preparation',{anchors:{instruction_published:anchor(),whole_fabric_arrived:anchor(),final_preparation_ready:anchor(12)}}));expect(row(r,'preparation_draft').end.at).toBe(at(24));expect(row(r,'preparation_final').end.at).toBe(at(36));expect(r.rows.some(n=>n.id==='production_sheet')).toBe(false);expect(r.overall.spanMs).toBe(60*hour);
  const old=calculateSlaPreview(route('preparation',{conditions:{...conditions,preparation:'legacy'},anchors:{customer_order_confirmed:anchor(),instruction_published:anchor(72),whole_fabric_arrived:anchor()}}));expect(row(old,'production_sheet').minutes).toBe(4320);expect(row(old,'production_sheet').independent).toBe(true);
 });
 it.each([['printing',168,156],['embroidery',168,156],['print_embroidery',240,228]] as const)('R3 %s uses actual catalog 96/168 + QC48 + dispatch24',(craft,before,after)=>{
  const p=route('bulk_craft',{conditions:{...conditions,craft}}),values=digitalSlaDefaults(),changed=digitalSlaDefaults();changed.bulk_qc={kind:'duration',minutes:2160};expect(calculateSlaPreview(p).overall.spanMs).toBe(before*hour);expect(calculateSlaPreview(calculationDraftGraph(p,{unified:values,development:{...DEVELOPMENT_CYCLE_DEFAULTS}},{unified:changed,development:{...DEVELOPMENT_CYCLE_DEFAULTS}})).overall.spanMs).toBe(after*hour);
 });
 it('R3 waits for a later selection approval, and does not insert craft QC on a no-craft route',()=>{
  const r=calculateSlaPreview(route('bulk_craft',{conditions:{...conditions,craft:'printing'},anchors:{cut_craft_dispatched:anchor(),sourcing_decided:anchor(200)}}));expect(r.overall.spanMs).toBe(224*hour);
  const none=calculateSlaPreview(route('bulk_craft',{anchors:{whole_cutting_completed:anchor(),sourcing_decided:anchor()}}));expect(none.rows.some(n=>n.id==='bulk_qc')).toBe(false);expect(none.overall.spanMs).toBe(24*hour);expect(row(none,'factory_selection_approved').basis).toBe('reference');
 });
 it('E8/E12 dates, logistics estimates, reminders and rework never manufacture a full production span',()=>{
  const r=calculateSlaPreview(route('delivery',{anchors:{factory_delivery_date:{precision:'date',value:'2026-11-30',source:'TEST target'},customer_shipping_date:{precision:'date',value:'2026-12-10',source:'TEST target'},factory_return_dispatched:anchor()}}));expect(r.overall.spanMs).toBeNull();expect(row(r,'return_logistics').kind).toBe('estimate');expect(row(r,'return_logistics').end.at).toBe(at(48));expect(row(r,'factory_production').end.at).toBeNull();expect(row(r,'ship_sample_advance').target?.at).toBe('2026-11-30T16:00:00.000Z');expect(r.rows.some(n=>n.id==='garment_rework')).toBe(false);
 });
 it('original packing-ready evidence starts the existing window, with no finance or duplicate shipping node',()=>{
  const p=route('delivery',{anchors:{garment_arrived:anchor(),original_packing_conditions_ready:anchor(50)}}),r=calculateSlaPreview(p);expect(row(r,'garment_inspection').end.at).toBe(at(48));expect(row(r,'garment_packing').end.at).toBe(at(74));expect(r.rows.some(n=>/finance|shipping_submission/.test(n.id))).toBe(false);
 });
 it('an unchanged global draft retains an older instance frozen value, and only explicit edits overlay it',()=>{
  const old=digitalSlaDefaults();old.development_pattern={kind:'duration',minutes:3000};const p=route('development',{values:old,unifiedSource:'TEST frozen source old version'}),current={unified:digitalSlaDefaults(),development:{...DEVELOPMENT_CYCLE_DEFAULTS}};
  expect(row(calculateSlaPreview(calculationDraftGraph(p,current,current)),'development_pattern').minutes).toBe(3000);
  const values=digitalSlaDefaults();values.development_pattern={kind:'duration',minutes:2160};expect(row(calculateSlaPreview(calculationDraftGraph(p,current,{...current,unified:values})),'development_pattern')).toMatchObject({minutes:2160,source:expect.stringContaining('未发布草稿')});
 });
 it('date-only logistics shift their original range under a draft without creating an actual midnight dispatch',()=>{
  const p=graph([node('estimate',2880,{kind:'estimate',anchorKey:null,parameterKey:'return_logistics',binding:{group:'unified',key:'return_logistics'},independent:true,estimateRange:{fromInclusive:at(48),toExclusive:at(72),shippedOn:'2026-11-02',source:'TEST native date-only shipment',actualDispatchedAt:null}})],['estimate']),values=digitalSlaDefaults(),draft=digitalSlaDefaults();draft.return_logistics={kind:'estimate',minutes:1440};const r=calculateSlaPreview(calculationDraftGraph(p,{unified:values,development:{...DEVELOPMENT_CYCLE_DEFAULTS}},{unified:draft,development:{...DEVELOPMENT_CYCLE_DEFAULTS}}));expect(row(r,'estimate').estimateRange).toMatchObject({fromInclusive:at(24),toExclusive:at(48),actualDispatchedAt:null});expect(row(r,'estimate').start.at).toBeNull();expect(r.overall.spanMs).toBeNull();
 });
});

describe('strict calculation contract and receipt binding',()=>{
 const input={selection:{mode:'example',range:'development',conditions,references:{development_published:anchor()}}};
 it('accepts partial explicitly referenced anchors without requiring nonexistent dates',()=>{expect(SlaCalculationPreviewSchema.parse(input).selection.mode).toBe('example');});
 it.each(['actor','graph','totalHours','previewToken','calculationReceipt'])('rejects client %s instead of trusting a claimed server result',(key)=>{expect(SlaCalculationPreviewSchema.safeParse({...input,[key]:'forged'}).success).toBe(false);});
 it('an instance cannot contain reference inputs, condition overrides, arbitrary completions or another actor',()=>{
  const selection={mode:'instance',range:'development',kind:'source',id:'11111111-1111-4111-8111-111111111111'};expect(SlaCalculationPreviewSchema.safeParse({selection}).success).toBe(true);for(const extra of [{references:{}},{conditions},{completedAt:t0},{actorId:'forged'}])expect(SlaCalculationPreviewSchema.safeParse({selection:{...selection,...extra}}).success).toBe(false);
 });
 it('version/identity/source/Date changes bind the receipt while key ordering alone does not',()=>{
  expect(slaCalculationDigest({a:1,b:{c:2}})).toBe(slaCalculationDigest({b:{c:2},a:1}));expect(slaCalculationDigest({time:new Date(t0)})).toBe(slaCalculationDigest({time:t0}));expect(slaCalculationDigest({time:new Date(t0)})).not.toBe(slaCalculationDigest({time:new Date(at(1))}));expect(slaCalculationDigest({source:'A',version:1})).not.toBe(slaCalculationDigest({source:'B',version:1}));
 });
});
