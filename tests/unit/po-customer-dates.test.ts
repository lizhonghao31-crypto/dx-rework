import {randomUUID} from 'node:crypto';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe,expect,it} from 'vitest';
import {InstructionDateRequestSchema,initialInstruction,type InstructionSheet} from '@dx-rework/contracts/production-instruction';
import {PoCustomerDates,PoCustomerDateHistory} from '../../apps/web/src/po-customer-dates.js';
import {DevelopmentCreateForm} from '../../apps/web/src/digital-development-create-form.js';
const lineId=randomUUID(),requestId=randomUUID();
const sheet={order:{},currentOrderVersion:1,document:initialInstruction(),customerPoDates:[{lineId,poNumber:'TEST-PO',color:'黑',date:'2026-12-10',registeredDate:'2026-12-10',version:1,source:'initial_po',factoryDate:null}],dateRequests:[{requestId,source:'po',oldDate:'2026-12-10',date:'2026-12-20',reason:'TEST客户要求',status:'待批准',requestedBy:'TEST主跟单',requestedAt:'2026-10-08T01:00:00Z',decidedBy:null,decidedAt:null,changes:[{lineId,poNumber:'TEST-PO',color:'黑',oldDate:'2026-12-10',date:'2026-12-20',expectedVersion:1}],approvalBlockedReason:null}]} as InstructionSheet;
const html=(patch:Partial<InstructionSheet>,historical=false)=>renderToStaticMarkup(createElement(PoCustomerDates,{sheet:{...sheet,...patch},busy:false,dirty:false,historical,onAct:async()=>true}));
describe('explicit PO customer promises and UI authority',()=>{
 it('refuses whole-order, empty, duplicate and oversized reason requests',()=>{
  const input={orderVersion:1,reason:'TEST',changes:[{lineId,expectedVersion:1,date:'2026-12-20'}]};
  expect(InstructionDateRequestSchema.safeParse(input).success).toBe(true);
  for(const invalid of [{orderVersion:1,reason:'TEST',date:'2026-12-20'},{...input,changes:[]},{...input,changes:[input.changes[0],input.changes[0]]},{...input,reason:'x'.repeat(501)}])expect(InstructionDateRequestSchema.safeParse(invalid).success).toBe(false);
 });
 it('keeps primary request and director decision separate after cutting',()=>{
  const primary=html({cutStarted:true,canRequestDate:true,canApproveDate:false});
  expect(primary).toContain('申请所选 PO 变更');expect(primary).not.toContain('>同意<');
  const director=html({cutStarted:true,canRequestDate:false,canApproveDate:true});
  expect(director).not.toContain('申请所选 PO 变更');expect(director).toContain('>同意<');
  expect(director).not.toMatch(/disabled=""[^>]*>同意/);
 });
 it('preserves dates and histories for other readers and historical snapshots without write controls',()=>{
  for(const historical of [false,true]){
   const reader=html({canRequestDate:false,canApproveDate:false},historical);
   expect(reader).toContain('TEST-PO');expect(reader).toContain('TEST客户要求');expect(reader).not.toContain('申请所选 PO 变更');expect(reader).not.toContain('>同意<');
  }
  expect(html({canRequestDate:true,canApproveDate:true},true)).not.toContain('申请所选 PO 变更');
 });
 it('shows every immutable PO change and blocks conflicted approval in the shared new and legacy history',()=>{
  const request={...sheet.dateRequests[0]!,changes:[...sheet.dateRequests[0]!.changes,{lineId:randomUUID(),poNumber:'TEST-OTHER-PO',color:'白',oldDate:'2026-12-12',date:'2026-12-28',expectedVersion:1}]};
  const render=(approvalBlockedReason:string|null,canApprove=true,changes=request.changes)=>renderToStaticMarkup(createElement(PoCustomerDateHistory,{requests:[{...request,approvalBlockedReason,changes}],canApprove,busy:false,onDecide:()=>undefined}));
  const allowed=render(null);
  for(const value of ['TEST-PO','TEST-OTHER-PO','2026-12-10','2026-12-20','2026-12-12','2026-12-28','TEST主跟单'])expect(allowed).toContain(value);
  expect(allowed).not.toMatch(/disabled=""[^>]*>同意/);
  const blocked=render('申请后母单已更新');expect(blocked).toContain('申请后母单已更新');expect(blocked).toMatch(/disabled=""[^>]*>同意/);expect(blocked).not.toMatch(/disabled=""[^>]*>驳回/);
  expect(render(null,false)).not.toContain('>同意<');expect(render(null,true,[])).toMatch(/disabled=""[^>]*>同意/);
 });
 it('retains the old whole-order request, actor and outcome without inventing PO scope',()=>{
  const request={...sheet.dateRequests[0]!,source:'delivery' as const,changes:[],status:'已批准',decidedBy:'TEST总监',decidedAt:'2026-10-08T02:00:00Z'};
  const markup=renderToStaticMarkup(createElement(PoCustomerDateHistory,{requests:[request],canApprove:true,busy:false,onDecide:()=>undefined}));
  for(const value of ['历史整单申请','2026-12-10','2026-12-20','TEST主跟单','TEST总监','已批准'])expect(markup).toContain(value);
  expect(markup).not.toContain('>同意<');expect(markup).not.toContain('TEST-PO');
 });
 it('shows only one formal PO field and customer promise in confirmed-order creation',()=>{
  const create=renderToStaticMarkup(createElement(DevelopmentCreateForm,{intent:'certain_order',customers:[],onCancel:()=>undefined,onCreated:()=>undefined}));
  expect(create).toContain('正式款号 / PO');expect(create).toContain('客户要求到仓日期');
  expect(create).not.toContain('客户合同交付日期');expect(create).not.toContain('工厂交货日');expect(create).not.toContain('明细约定交期');
  const development=renderToStaticMarkup(createElement(DevelopmentCreateForm,{intent:'development',customers:[],onCancel:()=>undefined,onCreated:()=>undefined}));
  expect(development).not.toContain('客户要求到仓日期');
 });
});
