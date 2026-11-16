import {describe,it,expect} from 'vitest';
import {InitialCustomerOrderDraftSchema} from '@dx-rework/contracts/digital-production';
import {initialDevelopmentDocument} from '../../apps/web/src/digital-development-editing.js';
import {publicationFormalInput} from '../../apps/api/src/production-platform/order-time-publication-intent.js';

const calendar={serverToday:'2026-11-16',minimumInitialCustomerDate:'2026-12-16',orderTimeEnabled:true};
const document=()=>({...initialDevelopmentDocument(),productionPlanning:{craftSteps:[],preshrink:false},customerOrderDraft:{withOrder:true,stage:'formal' as const,
 order:InitialCustomerOrderDraftSchema.parse({customerCode:'PD',productGroup:'男装',designStyleNo:'TEST-publish',orderDate:'2026-11-16',contractDeliveryDate:'2027-04-16',requiresColorMatching:false,salesYear:2027,salesSeries:'P04',primaryMerchandiserId:'a0000000-0000-4000-8000-000000000001',
  lines:[{formalPoNo:'TEST-PO1',color:'黑',customerWarehouseArrivalDate:'2027-04-16',deliveryDate:null,sizes:[{size:'M',quantity:'2'}]}]})}});

describe('development publication and formal ordering intent share the original readiness boundary',()=>{
 it('allows incomplete and partially dated ordering drafts to remain development intent',()=>{
  const blank=document();blank.customerOrderDraft.order.contractDeliveryDate=null;blank.customerOrderDraft.order.lines[0]!.customerWarehouseArrivalDate=null;
  const before=structuredClone(blank);expect(publicationFormalInput(blank,calendar,true)).toBeNull();expect(blank).toEqual(before);
  const partial=document();partial.customerOrderDraft.order.lines.push({...partial.customerOrderDraft.order.lines[0]!,formalPoNo:'TEST-PO2',color:'蓝',customerWarehouseArrivalDate:null});
  expect(publicationFormalInput(partial,calendar,true)).toBeNull();
 });
 it('never promotes a pre-order even when its other fields are complete',()=>{
  const value={...document(),customerOrderDraft:{...document().customerOrderDraft,stage:'preorder' as const}};
  expect(publicationFormalInput(value,calendar,true)).toBeNull();
 });
 it('requires actual A/B and production choices for a new framework, without assuming no craft or no preshrink',()=>{
  const matching=document();matching.customerOrderDraft.order.requiresColorMatching=null;expect(publicationFormalInput(matching,calendar,true)).toBeNull();
  const undecided={...document(),productionPlanning:{craftSteps:null,preshrink:null}};
  expect(publicationFormalInput(undecided,calendar,true)).toBeNull();
  expect(publicationFormalInput(undecided,calendar,false)).not.toBeNull();
 });
 it('preserves fully specified formal data and route without mutating the saved draft',()=>{
  const value=document(),before=structuredClone(value),formal=publicationFormalInput(value,calendar,true);
  expect(formal).toMatchObject({requiresColorMatching:false,salesSeries:'P04',productionPlanning:{craftSteps:[],preshrink:false},lines:[{formalPoNo:'TEST-PO1',customerWarehouseArrivalDate:'2027-04-16',sizes:[{size:'M',quantity:2}]}]});
  expect(value).toEqual(before);expect(formal!.productionPlanning).not.toBe(value.productionPlanning);
 });
 it('retains invalid draft quantities and future customer order facts for correction instead of manufacturing a formal order',()=>{
  const quantity=document();quantity.customerOrderDraft.order.lines[0]!.sizes[0]!.quantity='1.';
  expect(publicationFormalInput(quantity,calendar,true)).toBeNull();
  const future=document();future.customerOrderDraft.order.orderDate='2026-11-17';expect(publicationFormalInput(future,calendar,true)).toBeNull();
 });
});
