import {randomUUID} from 'node:crypto';
import type {QuotationResource} from '@dx-rework/contracts/digital-quotation';
import {MemberModuleBindingService} from '../../apps/api/src/access/member-module-binding-service.js';
import type {DigitalQuotationService} from '../../apps/api/src/production-platform/quotation-service.js';
import type {TrustedActorContext} from '../../apps/api/src/tools/repositories.js';
import type {businessAnchorFixture} from './business-anchor-fixture.js';

export async function bindFixtureCraftApprover(fixture:Awaited<ReturnType<typeof businessAnchorFixture>>){
 const current=(await fixture.db.query("SELECT user_id FROM business_module_owner_bindings WHERE member_key='wu_yunfeng'")).rows[0];
 if(current)return {...fixture.people.owner!,actorId:current.user_id};
 const approverId=randomUUID();
 await fixture.db.query("INSERT INTO app_users(id,display_name,enabled) VALUES($1,'TEST craft approver',true)",[approverId]);
 await fixture.db.query(`INSERT INTO identity_mappings(id,user_id,provider,corp_id,provider_user_id,union_id,active,employed,last_verified_at)
  VALUES($1,$2,'dingtalk','anchor-test',$3,$4,true,true,CURRENT_TIMESTAMP)`,
 [randomUUID(),approverId,'uat-test-craft-owner-'+approverId,'uat-test-craft-union-'+approverId]);
 await fixture.access.ensureOrganizationPolicy();
 await fixture.access.assignRole({...fixture.root,authorizationCapability:'access:admin',authorizationCapabilities:['access:admin']},
  {userId:approverId,roleCode:'owner_group',reason:'TEST separate verified craft approver'});
 await new MemberModuleBindingService(fixture.db).run(fixture.root.actorId,
  {li_zhonghao:fixture.people.owner!.actorId,wu_yunfeng:approverId,li_junyue:fixture.root.actorId},true);
 return {...fixture.people.owner!,actorId:approverId};
}

export async function submitFixtureCraftPrice(service:DigitalQuotationService,maker:TrustedActorContext,resource:QuotationResource,rowId:string,unitPrice:string){
 const quotation=await service.readSecondaryCraft(maker,resource,rowId);
 if(!quotation.target||!quotation.canEdit)throw Error('Current assigned craft not available in fixture');
 const action=unitPrice===''?'draft':'submit';
 const result=await service.writeSecondaryCraft(maker,resource,rowId,action,{
  expectedVersion:quotation.version,mode:'in_house',supplierId:null,unitPrice,unit:quotation.target.pricingUnit,
  applicableQuantity:null,note:'TEST original scope',attachmentIds:quotation.target.attachmentIds,
 },randomUUID());
 if(typeof result.receipt.appliedVersion!=='number')throw Error('Missing quotation approval fixture receipt');
 return result.receipt.appliedVersion;
}

export async function approveFixtureCraftPrice(service:DigitalQuotationService,maker:TrustedActorContext,approver:TrustedActorContext,
 resource:QuotationResource,rowId:string,unitPrice:string){
 const expectedVersion=await submitFixtureCraftPrice(service,maker,resource,rowId,unitPrice);
 await service.writeSecondaryCraft(approver,resource,rowId,'decision',{decision:'approved',expectedVersion},randomUUID());
}
