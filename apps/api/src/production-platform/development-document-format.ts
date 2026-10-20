import {beijingCalendarDate} from "@dx-rework/contracts/digital-production";
import {type DevelopmentDocument} from "@dx-rework/contracts/digital-development";
import {ApplicationError} from "../platform/errors.js";

const reject=(message:string):never=>{throw new ApplicationError("VALIDATION_ERROR",message,400);};
/** Called only with the original row held by the development command transaction. */
export function developmentDraftForSave(input:DevelopmentDocument,previous:DevelopmentDocument|undefined,createdAt:Date|string):DevelopmentDocument{
 const fixedDate=previous?.orderDate??beijingCalendarDate(new Date(createdAt));
 if(input.orderDate&&input.orderDate!==fixedDate)reject(`开发下单日期固定为${fixedDate}，请重新读取本单；客户下单日期在订单资料中单独填写`);
 if(previous?.documentFormatVersion===2&&(input.documentFormatVersion!==2||!input.sizeQuantities))reject("不能移除已保存的每码制作数量，请重新读取当前资料");
 return {...input,documentFormatVersion:2,sizeQuantities:input.sizeQuantities??input.sizes.map(()=>null),orderDate:fixedDate};
}
/** A new physical round always uses the new protocol; its source date remains the frozen first date. */
export function developmentRevisionForSave(input:DevelopmentDocument,basis:DevelopmentDocument):DevelopmentDocument{
 if(input.orderDate!==basis.orderDate)reject("实际复版不能改写首次开发下单日期，请保留原日期；客户日期独立办理");
 return {...input,documentFormatVersion:2,sizeQuantities:input.sizeQuantities??input.sizes.map(()=>null)};
}
export {developmentAmendmentPublicationOptions as legacyAmendmentPublicationOptions} from "@dx-rework/contracts/digital-development";
