import {beijingCalendarDate} from "@dx-rework/contracts/digital-production";
import {developmentSizeQuantityIssues,type DevelopmentDocument,type DevelopmentMakingUpgrade} from "@dx-rework/contracts/digital-development";
import {ApplicationError} from "../platform/errors.js";

const reject=(message:string):never=>{throw new ApplicationError("VALIDATION_ERROR",message,400);};
export function validateDevelopmentMaterialPlan(document:DevelopmentDocument,basis?:DevelopmentDocument){
 const before=new Map(basis?.materials.map(material=>[material.materialId,material]));
 for(const material of document.materials){
  const original=before.get(material.materialId);
  if(material.available!==(original?.available??false))reject('实物到料沿文员原核料记录办理，版单资料不能登记或改写实到');
  if(material.category!=='辅料'&&material.expectedDate!==null&&(material.category!==original?.category||material.expectedDate!==original.expectedDate))reject('预计到料日期只可填在辅料资料，面料沿原跟单流程');
 }
}
/** Called only with the original row held by the development command transaction. */
export function developmentDraftForSave(input:DevelopmentDocument,previous:DevelopmentDocument|undefined,createdAt:Date|string):DevelopmentDocument{
 const fixedDate=previous?.orderDate??beijingCalendarDate(new Date(createdAt));
 if(input.orderDate&&input.orderDate!==fixedDate)reject(`开发下单日期固定为${fixedDate}，请重新读取本单；客户下单日期在订单资料中单独填写`);
 if(previous?.workbenchSheet&&!input.workbenchSheet)reject("不能移除已保存的新版版单；请重新读取当前资料");
 if(previous&&!previous.workbenchSheet&&input.workbenchSheet)reject("原草稿须沿用保存时的版单格式");
 if(previous?.documentFormatVersion===2&&(input.documentFormatVersion!==2||!input.sizeQuantities))reject("不能移除已保存的每码制作数量，请重新读取当前资料");
 return {...input,...(previous?.quotationMode?{quotationMode:previous.quotationMode}:{}),documentFormatVersion:2,sizeQuantities:input.sizeQuantities??input.sizes.map(()=>null),orderDate:fixedDate};
}
/** A new physical round always uses the new protocol; its source date remains the frozen first date. */
export function developmentRevisionForSave(input:DevelopmentDocument,basis:DevelopmentDocument):DevelopmentDocument{
 if(basis.workbenchSheet&&!input.workbenchSheet)reject("复版须保留新版版单；请重新读取原资料");
 if(!basis.workbenchSheet&&input.workbenchSheet)reject("复版须沿用原版单格式");
 if(input.orderDate!==basis.orderDate)reject("实际复版不能改写首次开发下单日期，请保留原日期；客户日期独立办理");
 return {...input,...(basis.quotationMode?{quotationMode:basis.quotationMode}:{}),documentFormatVersion:2,sizeQuantities:input.sizeQuantities??input.sizes.map(()=>null)};
}
/** Existing tail/rework permission authorizes only explicit counts for the new round, never rewriting its frozen basis. */
export function developmentAutomaticRoundDocument(document:DevelopmentDocument,version:number,making:DevelopmentMakingUpgrade|undefined):DevelopmentDocument{
 if(!developmentSizeQuantityIssues(document).length){if(making)reject('本单已有有效各码制作数量；如需修改，请设计师从实际复版资料办理');return document;}
 if(!making)reject('历史资料缺少各码制作数量，请在本次退回／返工页逐码填写本轮制作数，0件不做；不会自动推算或改写旧资料');
 if(making!.expectedDocumentVersion!==version)throw new ApplicationError('DEVELOPMENT_CONFLICT','开发制作依据已更新，请重新读取后填写各码数量，本次未建立新轮',409);
 const upgraded={...document,documentFormatVersion:2 as const,sizeQuantities:making!.quantities};
 const errors=developmentSizeQuantityIssues(upgraded);if(errors.length)reject(errors.map(issue=>issue.message).join('；'));
 return upgraded;
}
export {developmentAmendmentPublicationOptions as legacyAmendmentPublicationOptions} from "@dx-rework/contracts/digital-development";
