import {describe,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {DevelopmentDocumentSchema} from '@dx-rework/contracts/digital-development';
import {developmentAmendmentErrors} from '@dx-rework/contracts/digital-development-amendments';
import {AUXILIARY_CATALOG_ROLES} from '@dx-rework/contracts/auxiliary-catalog';
import {initialDevelopmentDocument} from '../../apps/web/src/digital-development-editing.js';
import {canManageAuxiliaryCatalog} from '../../apps/web/src/auxiliary-catalog-access.js';
import {developmentFieldChapter} from '../../apps/web/src/digital-development-validation.js';
const reorder=(value:unknown):unknown=>Array.isArray(value)?value.map(reorder):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).reverse().map(([key,item])=>[key,reorder(item)])):value;
describe('G1 acceptance correction boundaries',()=>{
 it.each([false,true])('ignores JSON object key ordering, without ignoring customer order values or array positions (withOrder=%s)',withOrder=>{
  const before={...initialDevelopmentDocument(),quantity:2,sizeQuantities:[1,1],customerOrderDraft:{withOrder,order:{customerCode:'TEST',productGroup:'男装' as const,designStyleNo:'TEST-G1',temporaryStyleNo:null,orderDate:'2026-10-21',contractDeliveryDate:null,primaryMerchandiserId:null,lines:[{formalPoNo:null,poNumber:null,formalStyleNo:null,temporaryStyleNo:null,color:'TEST黑',colorForeign:null,deliveryDate:null,customerWarehouseArrivalDate:null,sizes:[{size:'M',quantity:'100'},{size:'L',quantity:'200'}]}]}}};
  const after=DevelopmentDocumentSchema.parse(reorder(before));after.materials[0]!.name='TEST主布';after.materials[0]!.specification='TEST 100%棉180g';expect(developmentAmendmentErrors(before,after)).toEqual([]);
  for(const modify of [(d:typeof after)=>{d.customerOrderDraft!.withOrder=!withOrder;},(d:typeof after)=>{d.customerOrderDraft!.order.lines[0]!.sizes.reverse();},(d:typeof after)=>{d.customerOrderDraft!.order.lines[0]!.sizes[0]!.quantity='101';},(d:typeof after)=>{delete d.customerOrderDraft!.order.primaryMerchandiserId;},(d:typeof after)=>{d.measurements[0]!.values[0]='60';},(d:typeof after)=>{d.sizeQuantities=[2,0];}]){const changed=structuredClone(after);modify(changed);expect(developmentAmendmentErrors(before,changed).join()).toContain('复版');}
 });
 it('makes the same directory entry available to precisely the five existing identities and capabilities',()=>{
  const user={id:randomUUID(),displayName:'TEST',capabilities:['auxiliary_catalog:write']};for(const role of AUXILIARY_CATALOG_ROLES)expect(canManageAuxiliaryCatalog({...user,businessRoles:[role]})).toBe(true);expect(canManageAuxiliaryCatalog({...user,capabilities:[],isRoot:true})).toBe(true);
  for(const businessRoles of [[],['development_clerk'],['pattern_room_worker'],['system_admin']])expect(canManageAuxiliaryCatalog({...user,businessRoles})).toBe(false);expect(canManageAuxiliaryCatalog({...user,businessRoles:['sample_designer'],capabilities:[]})).toBe(false);
 });
 it('maps each development issue family to its original chapter and leaves unrelated pages alone',()=>{
  const groups={'development-materials':[`development-${randomUUID()}-expectedDate`],'development-sizes':['development-size-quantities','development-size-quantity-0','development-size-0','development-measurement-row-0','development-template','development-unit'],'development-basic':['development-quantity','development-returnDate','development-pattern-preparation'],'development-images':['development-upload','development-instructions'],'development-craft':['development-washingMethod','development-packaging','development-sewingThread'],'development-labels':['development-mainLabelMethod']};
  for(const [chapter,ids]of Object.entries(groups))for(const id of ids)expect(developmentFieldChapter(id),id).toBe(chapter);expect(developmentFieldChapter('budget-section-1')).toBeUndefined();expect(developmentFieldChapter('customerCode')).toBeUndefined();
 });
});
