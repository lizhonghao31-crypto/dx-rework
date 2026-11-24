import {randomUUID} from 'node:crypto';
import {describe,it,expect} from 'vitest';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {CraftStepChoicesSchema,craftChoiceLabel,hasBothBuiltinCrafts,type CraftStepChoice,type SpecialCraftVersion} from '@dx-rework/contracts/digital-craft';
import {DevelopmentDocumentSchema,developmentCraftOptions,type DevelopmentDocument} from '@dx-rework/contracts/digital-development';
import {initialDevelopmentDocument} from '../../apps/web/src/digital-development-editing.js';
import {DevelopmentPrint} from '../../apps/web/src/digital-development-print.js';
import {digitalSlaDefaults,DIGITAL_SLA_RULE_VERSION} from '@dx-rework/contracts/digital-sla';
import {fixedDevelopmentWork} from '../../apps/api/src/production-platform/fixed-development-work.js';
import {fixedOrderWork} from '../../apps/api/src/production-platform/fixed-order-work.js';
import {fixedTimelineForward} from '../../apps/api/src/production-platform/fixed-timeline-targets.js';
import {FrozenOrderTimePlanSchema} from '@dx-rework/contracts/order-time-plan';
import {buildOrderTimeWork} from '../../apps/api/src/production-platform/order-time-schedule.js';
import {orderTimeInputFromRoute} from '../../apps/api/src/production-platform/order-time-request-plan.js';
import {orderTimeStoredBulkSteps,orderTimeBulkSteps} from '../../apps/api/src/production-platform/order-time-route-identities.js';
import {factoryStepLedger} from '../../apps/api/src/production-platform/factory-step-ledger.js';
import {secondaryCraftDevelopmentBasis} from '../../apps/api/src/production-platform/secondary-craft-development-basis.js';
import type {QuotationAssembly} from '@dx-rework/contracts/digital-quotation';
import {SecondaryCraftDecisionSchema,SecondaryCraftDraftSchema,SecondaryCraftSubmissionSchema} from '../../packages/contracts/src/secondary-craft-quotation.js';
import type {FixedWorkInputs} from '../../apps/api/src/production-platform/fixed-work-definition.js';
import type {BatchFact,BatchCheck} from '../../apps/api/src/production-platform/factory-batch-ledger.js';
const library=(name:string,dev:number,bulk:number):SpecialCraftVersion=>({id:randomUUID(),version:1,recordedAt:'2026-11-13T00:00:00.000Z',definition:{name,enabled:true,development:{minutes:dev,calendar:'continuous',reminder:{enabled:true,percent:70}},bulk:{minutes:bulk,calendar:'continuous',reminder:{enabled:true,percent:70}}}});
const a=library('TEST 激光',60,120),b=library('TEST 烫钻',120,240);
const steps:Array<CraftStepChoice&{stepId:string}>=[{craftKind:'special',specialCraft:a,sequence:1,stepId:randomUUID()},{craftKind:'printing',sequence:2,stepId:randomUUID()},{craftKind:'special',specialCraft:b,sequence:3,stepId:randomUUID()}];
const initial=():FixedWorkInputs=>({data:{unified:{configurationId:'TEST',snapshotRef:'TEST',values:{ruleVersion:DIGITAL_SLA_RULE_VERSION,parameters:Object.fromEntries(Object.entries(digitalSlaDefaults()).map(([key,value])=>[key,{value,source:'global',sourceVersion:1}]))}},development:null,planning:{standardRef:'TEST',version:1,values:{development_printing:{minutes:180,calendar:'continuous'},bulk_printing:{minutes:180,calendar:'continuous'},bulk_qc:{minutes:60,calendar:'continuous'}}}}});
describe('special crafts have distinct native steps rather than another combined printing task',()=>{
 it('requires concrete library entries and rejects accidental duplicate selection without merging distinct crafts',()=>{
  expect(CraftStepChoicesSchema.parse(steps.map(step=>({craftKind:step.craftKind,sequence:step.sequence,...(step.specialCraft?{specialCraft:step.specialCraft}:{})})))).toHaveLength(3);
  expect(craftChoiceLabel(steps)).toBe('TEST 激光 → 印花 → TEST 烫钻');
  expect(CraftStepChoicesSchema.safeParse([{craftKind:'special',sequence:1}]).success).toBe(false);
  expect(CraftStepChoicesSchema.safeParse([{craftKind:'special',specialCraft:a,sequence:1},{craftKind:'special',specialCraft:a,sequence:2}]).success).toBe(false);
 });
 it('does not confuse special-craft count with the legacy print/embroidery combined standard',()=>{
  expect(hasBothBuiltinCrafts(steps)).toBe(false);
  expect(hasBothBuiltinCrafts([steps[0]!,steps[1]!])).toBe(false);
  expect(hasBothBuiltinCrafts([...steps,{craftKind:'embroidery',sequence:4}])).toBe(true);
 });
 it('binds each development requirement to the selected craft version and a board in that document',()=>{
  const attachmentId=randomUUID(),craftSteps:CraftStepChoice[]=[
   {craftKind:'special',sequence:1,specialCraft:a},{craftKind:'printing',sequence:2},
  ];
  const document:DevelopmentDocument={...initialDevelopmentDocument(),craft:'特殊工艺',craftSteps,files:[{attachmentId,kind:'工艺开发板'}]};
  const key=developmentCraftOptions(document)[0]!.key;
  const requirement={stepKey:key,part:'袖口',specification:'单色',instructions:'沿原线',attachmentIds:[attachmentId]};
  expect(DevelopmentDocumentSchema.safeParse({...document,craftRequirements:[requirement]}).success).toBe(true);
  expect(DevelopmentDocumentSchema.safeParse({...document,craftRequirements:[requirement,requirement]}).success).toBe(false);
  expect(DevelopmentDocumentSchema.safeParse({...document,files:[],craftRequirements:[requirement]}).success).toBe(false);
  expect(DevelopmentDocumentSchema.safeParse({...document,files:[{attachmentId,kind:'菲林'}],craftRequirements:[requirement]}).success).toBe(false);
  const nextSteps:CraftStepChoice[]=[{craftKind:'special',sequence:1,specialCraft:{...a,version:a.version+1}},craftSteps[1]!];
  expect(DevelopmentDocumentSchema.safeParse({...document,craftSteps:nextSteps,craftRequirements:[requirement]}).success).toBe(false);
 });
 it('binds a secondary-craft approval basis to one development step, board and round',()=>{
  const board=randomUUID(),otherBoard=randomUUID(),replacement=randomUUID(),sourceId=randomUUID();
  const document:DevelopmentDocument={...initialDevelopmentDocument(),craft:'特殊工艺',
   craftSteps:[{craftKind:'special',sequence:1,specialCraft:a},{craftKind:'special',sequence:2,specialCraft:{...b,definition:{...b.definition,name:a.definition.name}}}],
   files:[{attachmentId:board,kind:'工艺开发板'},{attachmentId:otherBoard,kind:'工艺开发板'}],
   craftRequirements:[
    {stepKey:`special:${a.id}:${a.version}`,part:'袖口',specification:'双线',instructions:'',attachmentIds:[board]},
    {stepKey:`special:${b.id}:${b.version}`,part:'后背',specification:'单线',instructions:'',attachmentIds:[otherBoard]},
   ],
  };
  const row:QuotationAssembly['rows'][string]={kind:'craft',stage:'development',sourceRef:`craft:special:${a.id}`,basis:'unused',
   craftRef:{libraryId:a.id,libraryVersion:a.version,stepId:randomUUID()}};
  const snapshot={sourceId,round:1,version:2,document};
  const original=secondaryCraftDevelopmentBasis(snapshot,row);
  expect(original).toMatchObject({sourceId,round:1,sourceVersion:2,requirement:{part:'袖口',attachmentIds:[board]}});
  const changed=structuredClone(document);
  changed.craftRequirements![1]!.part='下摆';
  expect(secondaryCraftDevelopmentBasis({...snapshot,version:3,document:changed},row)).toMatchObject({sourceVersion:3,fingerprint:original!.fingerprint});
  changed.files[0]!.attachmentId=replacement;
  expect(secondaryCraftDevelopmentBasis({...snapshot,document:changed},row)).toBeNull();
  changed.craftRequirements![0]!.attachmentIds=[replacement];
  expect(secondaryCraftDevelopmentBasis({...snapshot,document:changed},row)?.fingerprint).not.toBe(original!.fingerprint);
  expect(secondaryCraftDevelopmentBasis({...snapshot,round:2},row)?.fingerprint).not.toBe(original!.fingerprint);
  expect(secondaryCraftDevelopmentBasis(snapshot,{...row,stage:'bulk'})).toBeNull();
  expect(secondaryCraftDevelopmentBasis(snapshot,{...row,craftRef:{...row.craftRef!,libraryVersion:a.version+1}})).toBeNull();
 });
 it('keeps a craft draft separate from exact submitted price and approver decisions',()=>{
  const supplierId=randomUUID();
  const common={expectedVersion:1,unit:'件',unitPrice:'0.123456',note:'',attachmentIds:[],applicableQuantity:null};
  const internal={...common,mode:'in_house',supplierId:null};
  const external={...common,mode:'outsourced',supplierId};
  const incomplete={...external,expectedVersion:0,supplierId:null,unit:'',unitPrice:''};
  expect(SecondaryCraftDraftSchema.safeParse(incomplete).success).toBe(true);
  expect(SecondaryCraftSubmissionSchema.safeParse(incomplete).success).toBe(false);
  expect(SecondaryCraftSubmissionSchema.safeParse(internal).success).toBe(true);
  expect(SecondaryCraftSubmissionSchema.safeParse({...internal,supplierId}).success).toBe(false);
  expect(SecondaryCraftSubmissionSchema.safeParse(external).success).toBe(true);
  expect(SecondaryCraftSubmissionSchema.safeParse({...external,expectedVersion:0}).success).toBe(true);
  expect(SecondaryCraftSubmissionSchema.safeParse({...external,supplierId:null}).success).toBe(false);
  expect(SecondaryCraftSubmissionSchema.safeParse({...external,unitPrice:'0.1234567'}).success).toBe(false);
  expect(SecondaryCraftSubmissionSchema.safeParse({...external,applicableQuantity:'abc'}).success).toBe(false);
  expect(SecondaryCraftSubmissionSchema.safeParse({...external,recipientId:randomUUID()}).success).toBe(false);
  expect(SecondaryCraftDecisionSchema.safeParse({decision:'approved',expectedVersion:1}).success).toBe(true);
  expect(SecondaryCraftDecisionSchema.safeParse({decision:'approved',expectedVersion:0}).success).toBe(false);
  expect(SecondaryCraftDecisionSchema.safeParse({decision:'approved',expectedVersion:1,actorId:randomUUID()}).success).toBe(false);
  expect(SecondaryCraftDecisionSchema.safeParse({decision:'returned',expectedVersion:1,reason:'请核对工艺图'}).success).toBe(true);
  expect(SecondaryCraftDecisionSchema.safeParse({decision:'returned',expectedVersion:1,reason:''}).success).toBe(false);
 });
 it('prints each craft with the selected snapshot requirements and original board links',()=>{
  const originalBoard=randomUUID(),printingBoard=randomUUID(),revisedBoard=randomUUID();
  const craftSteps:CraftStepChoice[]=[{craftKind:'special',sequence:1,specialCraft:a},{craftKind:'printing',sequence:2}];
  const original:DevelopmentDocument={...initialDevelopmentDocument(),craft:'特殊工艺',craftSteps,
   files:[{attachmentId:originalBoard,kind:'工艺开发板'},{attachmentId:printingBoard,kind:'工艺开发板'}],
  };
  const [special,printing]=developmentCraftOptions(original);
  original.craftRequirements=[
   {stepKey:special!.key,part:'原版袖口',specification:'双线效果',instructions:'沿版标定位',attachmentIds:[originalBoard]},
   {stepKey:printing!.key,part:'后幅',specification:'单色',instructions:'纸样定位',attachmentIds:[printingBoard]},
  ];
  const revised:DevelopmentDocument={...original,files:[{attachmentId:revisedBoard,kind:'工艺开发板'},original.files[1]!],
   craftRequirements:[{...original.craftRequirements[0]!,attachmentIds:[revisedBoard]},original.craftRequirements[1]!],
  };
  const sheet={sourceId:randomUUID(),designStyleNo:'TEST',temporaryStyleNo:null,customerCode:null,developmentType:'头版',
   designerName:'TEST设计师',version:2,status:'published' as const,document:revised,publishedAt:null,taskId:null,canEdit:false,materialEvents:[]};
  const print=(document:DevelopmentDocument,version:number)=>renderToStaticMarkup(createElement(DevelopmentPrint,{
   sheet:{...sheet,version},document,imageUrl:id=>`/versions/${version}/attachments/${id}`,
  }));
  const old=print(original,1),current=print(revised,2);
  const specialSection=old.match(/<section aria-label="TEST 激光">(.*?)<\/section>/s)?.[1];
  const printingSection=old.match(/<section aria-label="印花">(.*?)<\/section>/s)?.[1];
  expect(specialSection).toContain('<td>原版袖口</td>');
  expect(specialSection).toContain('<td>双线效果</td>');
  expect(specialSection).toContain('<td>沿版标定位</td>');
  expect(specialSection).toContain(`/versions/1/attachments/${originalBoard}">工艺开发板 1`);
  expect(specialSection).not.toContain(printingBoard);
  expect(printingSection).toContain(`/versions/1/attachments/${printingBoard}">工艺开发板 2`);
  expect(old).not.toContain(revisedBoard);
  expect(current).toContain(`/versions/2/attachments/${revisedBoard}`);
  expect(current).not.toContain(originalBoard);
  const legacy=print({...original,craftRequirements:undefined},1);
  expect(legacy).not.toContain('<h4>工艺要求</h4>');
  expect(legacy).toContain(`/versions/1/attachments/${originalBoard}">工艺开发板</a>`);
 });
 it('uses each development value, includes each handoff once and preserves real serial order',()=>{
  const kinds=steps.flatMap(()=>['development_craft_dispatch','development_printing','development_craft_confirmation'] as const);
  const route=fixedDevelopmentWork(initial(),'TEST',1,kinds,steps,false,'免洗',false);
  const parents=route.work.filter(work=>!work.includedIn);
  expect(parents.map(work=>work.minutes)).toEqual([60,180,120]);
  expect(new Set(route.work.map(work=>work.id)).size).toBe(9);
  expect(route.route.filter(row=>row.phase==='work').map(row=>row.stepId)).toEqual(steps.map(step=>step.stepId));
  const forward=fixedTimelineForward(route.work,{precision:'instant',value:'2026-11-13T00:00:00.000Z',source:'TEST start'});
  expect(forward.find(node=>node.id===parents[2]!.id)?.end.at).toBe('2026-11-13T06:00:00.000Z');
  expect(route.work.filter(work=>work.includedIn).map(work=>work.includedIn)).toEqual(parents.flatMap(work=>[work.id,work.id]));
 });
 it('uses bulk values separately and adds one QC for every actual step',()=>{
  const result=fixedOrderWork(initial(),'TEST order','TEST source',1,'不需预缩',steps,false,null,[]);
  const craft=result.work.filter(work=>work.parameterKey?.startsWith('bulk_special_')||work.parameterKey==='bulk_printing');
  expect(craft.map(work=>work.minutes)).toEqual([120,180,240]);
  expect(result.work.filter(work=>work.parameterKey==='bulk_qc')).toHaveLength(3);
  expect(result.route.filter(work=>work.kind==='process_logistics').map(work=>work.stepId)).toEqual(steps.map(step=>step.stepId));
 });
 it('keeps immutable library policy through the order-plan adapter and later route reconstruction',()=>{
  const base=initial(),plan=FrozenOrderTimePlanSchema.parse({version:'order-time-plan-v1',revision:1,company:{version:'order-time-standard-v1',reference:'TEST frozen',revision:1,nodes:{},stageBufferMinutes:0},overrides:{}});
  base.data.orderTimePlan=plan;
  const route=fixedOrderWork(base,'TEST order','TEST source',1,'不需预缩',steps,false,null,[]);
  const input=orderTimeInputFromRoute(plan,route,new Map(),true);
  const work=buildOrderTimeWork(plan,input.work);
  expect(work.filter(node=>node.id.startsWith('bulk_special_')).map(node=>node.minutes)).toEqual([120,240]);
  const restored=orderTimeStoredBulkSteps(input);
  expect(restored.map(step=>step.specialCraft?.definition.name??step.craftKind)).toEqual(['TEST 激光','printing','TEST 烫钻']);
  expect(orderTimeBulkSteps('TEST order',2,steps,restored)).toEqual(restored);
  const special=input.work.find(node=>node.craftStep?.specialCraft?.id===a.id)!;
  const overridden=structuredClone(plan);overridden.overrides[special.parameterKey]={kind:'work',minutes:90,calendar:'continuous',reminder:{enabled:true,percent:60}};
  expect(buildOrderTimeWork(overridden,input.work).find(node=>node.id===special.id)?.minutes).toBe(90);
  expect(buildOrderTimeWork(plan,input.work).find(node=>node.id===special.id)?.minutes).toBe(120);
  const corrupted=structuredClone(input.work);corrupted.find(node=>node.id===special.id)!.parameterKey='bulk_special_wrong';
  expect(()=>buildOrderTimeWork(plan,corrupted)).toThrow('身份不一致');
 });
 it('only exposes final qualified pieces, never sums the same pieces across three steps',()=>{
  const facts:BatchFact[]=[],checks:BatchCheck[]=[];
  for(const [index,step]of steps.entries()){
   facts.push({fact_id:'s'+index,kind:'工艺发出',payload:{stepRef:step.stepId,lines:[{lineId:'po',quantity:100}],...(index?{fromReturnId:'r'+(index-1)}:{})},occurred_at:'2026-11-13T01:00:00Z'});
   facts.push({fact_id:'r'+index,kind:'工艺回仓',payload:{stepRef:step.stepId,sendFactId:'s'+index,lines:[{lineId:'po',quantity:100}]},occurred_at:'2026-11-13T02:00:00Z'});
   checks.push({return_fact_id:'r'+index,line_id:'po',result:'合格',checked_at:'2026-11-13T03:00:00Z'});
  }
  const pending=factoryStepLedger([{lineId:'po',quantity:100}],facts,checks.slice(0,2),steps);expect(pending.canDispatch).toBe(false);
  const result=factoryStepLedger([{lineId:'po',quantity:100}],facts,checks,steps);
  expect(result.batches).toHaveLength(1);expect(result.batches[0]!.rows[0]!.available).toBe(100);expect(result.canDispatch).toBe(true);expect(result.complete).toBe(false);
 });
});
