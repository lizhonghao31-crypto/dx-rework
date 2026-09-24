import {CreateSupplierSchema,ReviseSupplierSchema,SUPPLIER_REQUIRED_FIELDS} from "@dx-rework/contracts";
import type {SupplierSummary} from "./supplier-center-model.js";
export type SupplierProfile = SupplierSummary & Readonly<{
  notes: string;
  contactPerson: string | null;
  contactPhone: string | null;
  address: string | null;
  contractEntityName?: string | null;
  partyBRepresentative?: string | null;
  payeeName?: string | null;
  bankAccount?: string | null;
  bankName?: string | null;
  changeReason: string;
  changedBy: string;
  changedByName?: string | null;
  changedAt: string;
}>;

export type SupplierDraft = {
  supplierCode: string;
  supplierType: SupplierSummary["supplierType"];
  supplierName: string;
  active: boolean;
  notes: string;
  contactPerson: string;
  contactPhone: string;
  address: string;
  contractEntityName: string;
  partyBRepresentative: string;
  payeeName: string;
  bankAccount: string;
  bankName: string;
  supportedCrafts: string;
  dailyCapacity: string;
  changeReason: string;
};

export const emptyDraft = (): SupplierDraft => ({
  supplierCode: "",
  supplierType: "factory",
  supplierName: "",
  active: true,
  notes: "",
  contactPerson: "",
  contactPhone: "",
  address: "",
  contractEntityName: "",
  partyBRepresentative: "",
  payeeName: "",
  bankAccount: "",
  bankName: "",
  supportedCrafts: "",
  dailyCapacity: "",
  changeReason: "",
});

export const draftFromProfile = (profile: SupplierProfile): SupplierDraft => ({
  supplierCode: profile.supplierCode,
  supplierType: profile.supplierType,
  supplierName: profile.supplierName,
  active: profile.active,
  notes: profile.notes,
  contactPerson: profile.contactPerson ?? "",
  contactPhone: profile.contactPhone ?? "",
  address: profile.address ?? "",
  contractEntityName: profile.contractEntityName && profile.contractEntityName !== profile.supplierName
    ? profile.contractEntityName
    : "",
  partyBRepresentative: profile.partyBRepresentative ?? "",
  payeeName: profile.payeeName ?? "",
  bankAccount: profile.bankAccount ?? "",
  bankName: profile.bankName ?? "",
  supportedCrafts: profile.supportedCrafts.join("、"),
  dailyCapacity: profile.dailyCapacity === null ? "" : String(profile.dailyCapacity),
  changeReason: "",
});


const nullable=(value:string)=>value.trim()||null;
export function supplierDraftPayload(draft:SupplierDraft,context:{creating:boolean;code:string;version:number}){
 const required=SUPPLIER_REQUIRED_FIELDS;
 const missing=required.filter(([key])=>!String(draft[key]).trim()).map(([,label])=>label);
 if(missing.length)return {success:false as const,error:'请填写：'+missing.join('、')};
 if(!context.creating&&!draft.changeReason.trim())return {success:false as const,error:'请填写修改原因'};
 const fields={supplierName:draft.supplierName.trim(),active:draft.active,notes:draft.notes.trim(),contactPerson:nullable(draft.contactPerson),contactPhone:nullable(draft.contactPhone),address:nullable(draft.address),contractEntityName:nullable(draft.contractEntityName),partyBRepresentative:nullable(draft.partyBRepresentative),payeeName:nullable(draft.payeeName),bankAccount:nullable(draft.bankAccount),bankName:nullable(draft.bankName),supportedCrafts:draft.supportedCrafts.split(/[、,，]/).map(s=>s.trim()).filter(Boolean),dailyCapacity:draft.dailyCapacity.trim()?Number(draft.dailyCapacity):null,changeReason:draft.changeReason.trim()||(context.creating?'前端新增供应商资料':'')};
 const parsed=context.creating?CreateSupplierSchema.safeParse({...fields,supplierCode:draft.supplierCode.trim()||context.code,supplierType:draft.supplierType}):ReviseSupplierSchema.safeParse({...fields,expectedVersion:context.version});
 if(!fields.supportedCrafts.length)return {success:false as const,error:'请填写可承接工艺'};
 if(!parsed.success)return {success:false as const,error:'请检查字段长度、编码格式、工艺重复项及日产能（1至10亿的整数）。'};
 return {success:true as const,data:parsed.data};
}
