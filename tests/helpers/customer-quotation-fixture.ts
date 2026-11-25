import {businessNow} from '../../apps/api/src/acceptance-clock/business-time.js';
import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import type {TrustedActorContext} from '../../apps/api/src/tools/repositories.js';
import {DigitalQuotationService} from '../../apps/api/src/production-platform/quotation-service.js';
import {QuotationConfirmationSchema} from '@dx-rework/contracts/digital-quotation';
/** Synthetic customer confirmation through native commands. Never called by
 * application code and never disables a money/state/database business guard. */
export async function customerQuotationFixture(db:Pool,root:TrustedActorContext,orderId:string,total='100000',designer?:TrustedActorContext){
 if(!root.actorRoles.includes('root_superuser'))throw new Error('Fixture requires its isolated Root actor');
 const name=(await db.query('SELECT current_schema() AS name')).rows[0].name;
 if(!/_[a-f0-9]{32}$/.test(name))throw new Error('Quotation fixture requires an owned disposable test schema');
 const order=(await db.query(`SELECT coalesce(s.created_by,o.created_by) AS created_by,o.customer_code FROM digital_production_orders o
  LEFT JOIN digital_production_sources s ON s.source_id=o.source_id WHERE o.production_order_id=$1`,[orderId])).rows[0];
 const confirming=designer?.actorId===order.created_by?designer:root;
 if(confirming===root&&order.created_by!==root.actorId)throw Error('Fixture requires the actual quotation author');
 const service=new DigitalQuotationService(db,true),resource={kind:'order' as const,id:orderId},rowId=randomUUID();
 let quote=await service.save(root,resource,{expectedVersion:0,document:{fabricType:'TEST',productCategory:'TEST',monthSeries:'',date:'2026-01-01',currency:'人民币',rows:[{rowId,section:'主料',category:'TEST',name:'TEST 报价物料',specification:'TEST',unit:'件',supplier:'TEST',consumption:'',unitPrice:'1'}],freight:'0',cm:'0',salePrice:'',outsourcingScope:'TEST',outsourcingUnitPrice:'1',imageAttachmentIds:[]},assignments:[{rowId,technicalAssigneeId:root.actorId,priceAssigneeId:order.created_by,priceRole:'sample_designer'}]},randomUUID());
 quote=await service.fillRow(root,resource,rowId,{expectedVersion:quote.version,consumption:'1'},randomUUID());
 const authority=(await db.query(`SELECT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('digital_secondary_craft_quote_decisions')
  AND attname='approval_authority' AND NOT attisdropped) ready`)).rows[0]?.ready;
 await service.confirm(confirming,resource,QuotationConfirmationSchema.parse({expectedVersion:quote.version,customerCode:order.customer_code,customerConfirmedTotal:total,amountScope:'per_piece',quantity:null,quantityUnit:'件',currency:'人民币',taxBasis:'excludes_tax',sourceKind:'explicit_customer_confirmation',sourceField:'customerConfirmedTotal',templateVersion:'online-quotation-v1',evidenceNote:'TEST disposable fixture customer confirmation, unrelated to real customer data',confirmedAt:businessNow().toISOString(),
  ...(authority&&confirming!==root?{workbenchPricing:{field:'customerUnitPrice',value:total}}:{})}),randomUUID());
 return {quoteVersion:quote.version,budgetVersion:1};
}
