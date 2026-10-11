import {z} from 'zod';
import type {BudgetSourcingPreparation} from '@dx-rework/contracts/digital-budget';
const uuid=z.string().uuid(),date=z.string().max(10).refine(value=>!value||/^\d{4}-\d{2}-\d{2}$/.test(value));
const image=z.object({attachmentId:uuid,filename:z.string().max(255),mimeType:z.enum(['image/jpeg','image/png','image/webp'])}).strict();
const schema=z.object({userId:uuid,productionOrderId:uuid,budgetVersion:z.number().int().positive(),orderVersion:z.number().int().positive(),savedAt:z.string().datetime(),
 additionalMerchandiserUserId:z.union([z.literal(''),uuid]),estimatedCutPieceSendDate:date,deliveryDate:date,
 lines:z.array(z.object({lineId:uuid,factoryDeliveryDate:date,styleNo:z.string().max(100),imageAttachmentId:z.union([z.literal(''),uuid])}).strict()).max(20),extraImages:z.array(image).max(20)
}).strict();
export type BudgetSourcingDraft=z.infer<typeof schema>;
export type BudgetDraftScope=Pick<BudgetSourcingDraft,'userId'|'productionOrderId'|'budgetVersion'>;
type Storage=Pick<globalThis.Storage,'getItem'|'setItem'|'removeItem'>;
const prefix='dx-rework:budget-sourcing-manual:v1';
export const budgetSourcingDraftKey=(scope:BudgetDraftScope)=>`${prefix}:${scope.userId}:${scope.productionOrderId}:${scope.budgetVersion}`;
const latestKey=(scope:BudgetDraftScope)=>`${prefix}:${scope.userId}:${scope.productionOrderId}:latest`;
export function readBudgetSourcingDraft(storage:Storage,scope:BudgetDraftScope):BudgetSourcingDraft|null{
 try{
  const latest=Number(storage.getItem(latestKey(scope))),versions=[scope.budgetVersion,...(Number.isSafeInteger(latest)&&latest>0&&latest!==scope.budgetVersion?[latest]:[])];
  for(const budgetVersion of versions){const parsed=schema.safeParse(JSON.parse(storage.getItem(budgetSourcingDraftKey({...scope,budgetVersion}))??'null'));
   if(parsed.success&&parsed.data.userId===scope.userId&&parsed.data.productionOrderId===scope.productionOrderId&&parsed.data.budgetVersion===budgetVersion)return parsed.data;
  }
 }catch{/* Corrupt or unavailable browser storage never becomes authoritative source data. */}
 return null;
}
export function saveBudgetSourcingDraft(storage:Storage,input:unknown){const draft=schema.parse(input);storage.setItem(budgetSourcingDraftKey(draft),JSON.stringify(draft));storage.setItem(latestKey(draft),String(draft.budgetVersion));}
export function clearBudgetSourcingDraft(storage:Storage,scope:BudgetDraftScope){storage.removeItem(budgetSourcingDraftKey(scope));if(storage.getItem(latestKey(scope))===String(scope.budgetVersion))storage.removeItem(latestKey(scope));}
export function recoverBudgetSourcingManual(prepared:BudgetSourcingPreparation,draft:BudgetSourcingDraft){
 const changed=draft.budgetVersion!==prepared.budgetVersion||draft.orderVersion!==prepared.orderVersion;
 const images=[...prepared.images,...draft.extraImages.filter(image=>!prepared.images.some(value=>value.attachmentId===image.attachmentId))],ids=new Set(images.map(image=>image.attachmentId));
 let discarded=0;
 const lines=prepared.lineItems.map(line=>{const manual=draft.lines.find(value=>value.lineId===line.lineId);const proposed=manual?.factoryDeliveryDate??'';
  const valid=!proposed||(!draft.estimatedCutPieceSendDate||proposed>=draft.estimatedCutPieceSendDate)&&(!line.customerWarehouseArrivalDate||proposed<=line.customerWarehouseArrivalDate);
  if(!valid)discarded++;
  return{...line,styleNo:!changed&&manual?manual.styleNo:line.styleNo||manual?.styleNo||'',factoryDeliveryDate:valid?proposed:'',imageAttachmentId:manual&&ids.has(manual.imageAttachmentId)?manual.imageAttachmentId:''};
 });
 discarded+=draft.lines.filter(manual=>!prepared.lineItems.some(line=>line.lineId===manual.lineId)).length;
 return{changed,discarded,imageOverflow:Math.max(0,images.length-20),images,lines,additionalMerchandiserUserId:draft.additionalMerchandiserUserId,estimatedCutPieceSendDate:draft.estimatedCutPieceSendDate,deliveryDate:draft.deliveryDate};
}
