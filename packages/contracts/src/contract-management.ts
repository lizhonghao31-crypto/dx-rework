import { z } from "zod";

export const CONTRACT_TERM_LABELS = {
  processingResponsibility: "加工责任（保留 {{工艺}} 自动带入订单工艺）",
  qualityRequirements: "质量要求",
  delayPenalty: "交货时间与延期扣款",
  logistics: "交货地点及运输方式",
  reasonableLoss: "物料合理损耗及计算方法",
  defectRate: "次品率",
  payment: "付款方式",
  effectiveness: "生效与补充协议",
  validity: "有效期",
} as const;
const clause = z.string().trim().min(1).max(4000);
export const ContractTemplateContentSchema = z.object({
  templateName: z.string().trim().min(1).max(100),
  partyAName: z.string().trim().min(1).max(200),
  partyAAddress: z.string().trim().min(1).max(500),
  signingPlace: z.string().trim().min(1).max(200),
  terms: z.object({
    processingResponsibility: clause.refine(value => value.split("{{工艺}}").length === 2,
      "加工责任须保留一个 {{工艺}}，用于自动带入订单工艺"),
    qualityRequirements: clause, delayPenalty: clause, logistics: clause,
    reasonableLoss: clause, defectRate: clause, payment: clause,
    effectiveness: clause, validity: clause,
  }).strict(),
}).strict();
export const ContractTemplateSchema = ContractTemplateContentSchema.extend({
  templateVersion: z.number().int().positive(),
  createdAt: z.string().datetime(),
});
export const ContractTemplateStateSchema = z.object({
  item: ContractTemplateSchema,
  history: z.array(ContractTemplateSchema),
}).strict();
export const SaveContractTemplateSchema = ContractTemplateContentSchema.extend({
  expectedVersion: z.number().int().positive(),
}).strict();
export const CONTRACT_SUPPLIER_FIELDS = {
  supplierName: "供应商名称", supplierCode: "供应商编号",
  contractEntityName: "合同主体", address: "地址",
  partyBRepresentative: "乙方代表", payeeName: "收款人",
  bankAccount: "银行账号", bankName: "开户行",
} as const;
export const CONTRACT_REFRESH_FIELDS = {
  ...CONTRACT_SUPPLIER_FIELDS,
  templateVersion: "模板版本", partyAName: "甲方名称", partyAAddress: "甲方地址", signingPlace: "签订地点",
  processingResponsibility: CONTRACT_TERM_LABELS.processingResponsibility,
  qualityRequirements: CONTRACT_TERM_LABELS.qualityRequirements, delayPenalty: CONTRACT_TERM_LABELS.delayPenalty,
  logistics: CONTRACT_TERM_LABELS.logistics, reasonableLoss: CONTRACT_TERM_LABELS.reasonableLoss,
  defectRate: CONTRACT_TERM_LABELS.defectRate, payment: CONTRACT_TERM_LABELS.payment,
  effectiveness: CONTRACT_TERM_LABELS.effectiveness, validity: CONTRACT_TERM_LABELS.validity,
} as const;
export const ContractRefreshPreviewSchema = z.object({
  sourcingContractDocumentId: z.string().uuid(),
  informationFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  returned: z.boolean(),
  changes: z.array(z.object({
    field: z.enum(Object.keys(CONTRACT_REFRESH_FIELDS) as [keyof typeof CONTRACT_REFRESH_FIELDS, ...(keyof typeof CONTRACT_REFRESH_FIELDS)[]]),
    before: z.string(), after: z.string(),
  }).strict()),
  missingFields: z.array(z.string()),
}).strict();
export const RefreshContractInformationSchema = z.object({
  sourcingContractDocumentId: z.string().uuid(),
  informationFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();
export type ContractTemplateContent = z.infer<typeof ContractTemplateContentSchema>;
export type ContractTemplate = z.infer<typeof ContractTemplateSchema>;
export type ContractTemplateState = z.infer<typeof ContractTemplateStateSchema>;
export type SaveContractTemplate = z.infer<typeof SaveContractTemplateSchema>;
export type ContractRefreshPreview = z.infer<typeof ContractRefreshPreviewSchema>;
export type RefreshContractInformation = z.infer<typeof RefreshContractInformationSchema>;

// A contract-only snapshot. Editing it never writes the approved order facts.
const contentText = z.string().max(4000);
const decimal = z.string().regex(/^\d{1,12}(?:\.\d{1,4})?$/, "请输入有效的非负金额");
export const ContractContentSchema = z.object({
  contractNumber: z.string().trim().min(1).max(100), contractDate: contentText,
  contractTitle: contentText.optional(), partyARepresentative: contentText.optional(),
  partyASigningDate: contentText.optional(), partyBSigningDate: contentText.optional(),
  partyAName: contentText, partyAAddress: contentText, partyBName: contentText,
  partyBAddress: contentText, partyBRepresentative: contentText,
  payeeName: contentText, bankAccount: contentText, bankName: contentText,
  signingPlace: contentText, gender: contentText, styleName: contentText,
  estimatedCutPieceSendDate: contentText, deliveryDate: contentText,
  processes: z.array(z.string().max(200)).max(100),
  lines: z.array(z.object({
    lineId: z.string().uuid().optional(), deliveryDate: z.iso.date().optional(),
    position: z.number().int().positive(), styleNo: contentText,
    alternateStyleNo: contentText.nullable(), color: contentText.nullable(),
    imageAttachmentId: z.string().uuid().nullable().optional(), imageSha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    quantity: z.number().int().min(0).max(999999999), unitPrice: decimal, totalAmount: decimal,
  }).strict()).min(1).max(100),
  totalQuantity: z.number().int().min(0).max(999999999), totalAmount: decimal,
  terms: z.object(Object.fromEntries(Object.keys(CONTRACT_TERM_LABELS).map(key => [key,contentText])) as Record<keyof typeof CONTRACT_TERM_LABELS, typeof contentText>).strict(),
}).strict();
export const ContractContentStateSchema = z.object({
  sourcingContractDocumentId: z.string().uuid(), informationFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  poFactoryDates: z.array(z.object({
    styleNo: z.string().optional(), color: z.string().optional(),
    lineId: z.string().uuid(), position: z.number().int().positive(),
    factoryDeliveryDate: z.iso.date().nullable(), expectedVersion: z.number().int().nonnegative(),
    customerWarehouseArrivalDate: z.iso.date().nullable(),
  }).strict()).max(50).optional(),
  content: ContractContentSchema,
}).strict();
export const SaveContractContentSchema = ContractContentStateSchema.refine(input =>
  input.poFactoryDates !== undefined || !input.content.deliveryDate.startsWith("0000-") && z.iso.date().safeParse(input.content.deliveryDate).success,
  {path:["content","deliveryDate"],message:"交货日期必须是真实的日历日期"});
export type ContractContent = z.infer<typeof ContractContentSchema>;
export type ContractContentState = z.infer<typeof ContractContentStateSchema>;
export type SaveContractContent = z.infer<typeof SaveContractContentSchema>;
