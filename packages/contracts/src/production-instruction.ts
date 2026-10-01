import { z } from "zod";
import type { DigitalOrder } from "./digital-production.js";
const short = z.string().trim().max(200), text = z.string().trim().max(5000);
export const SEWING_REQUIREMENTS = [
  "1、针距一英寸12针，线迹良好，不可有跳针断线，面线不可有明显接驳线迹。尺寸跟足尺寸表，控制在误差范围内；",
  "2、大货车缝线色及粗细需按样板配好，不接受色差，退线只接受退三针，不能有接线、断线、跳针问题；",
  "3、各部位缝合要平整，不能有褶皱、起拱或扭曲，压线要顺直，宽窄一致；",
  "4、整件完成不可有色差、污渍、断线、破洞，线头要清理干净，各部位整烫平服；注意门禁拉链不能起拱，不同码数拉链长度不同，扣子、钩扣需定好位再打，不能错位，扣子、钩扣需牢固，左右袋需对称，大小一致。",
] as const;
export const MATERIAL_COUNT_TERM = "大货面、辅料到贵公司，请在48小时之内清点数量，并确认收到的面、辅料是否正确，数量是否对数，如不正确，及时跟我司沟通，并及时补齐数量，如贵司不能及时清点数量，由贵司承担相应责任，感谢贵司的支持及配合！";
export const InstructionDocumentSchema = z.object({
  styleName: short, category: short, season: short, fabricType: short, composition: text,
  date: z.iso.date().nullable(), process: text, remarks: text, patternMaker: short,
  preshrink: z.enum(["待确认", "需要预缩", "无需预缩"]), shipSample: text,
  sewingRequirements: text, comments: text,
  fabrics: z.array(z.object({ id: z.string().uuid(), name: short, part: short, colors: z.record(z.string().uuid(), short), remarks: text }).strict()).max(200),
  accessories: z.array(z.object({ id: z.string().uuid(), group: z.enum(["车缝", "包装"]), garmentColors: short, materialColor: short, name: short, category: short, part: short, specification: short, consumption: short, remarks: text }).strict()).max(400),
  images: z.array(z.object({ attachmentId: z.string().uuid(), kind: z.enum(["款图", "主唛", "腰卡", "吊牌", "洗水唛", "二维码唛", "包装辅料", "其它工艺"]), description: text }).strict()).max(60),
  unit: z.enum(["inch", "cm"]), sizes: z.array(short.min(1)).max(50),
  measurements: z.array(z.object({ id: z.string().uuid(), name: short, tolerance: short, method: text, values: z.array(short).max(50) }).strict()).max(200),
}).strict().superRefine((doc, ctx) => {
  if (new Set(doc.sizes).size !== doc.sizes.length) ctx.addIssue({ code: "custom", message: "尺码列不能重复", path: ["sizes"] });
  if (doc.measurements.some(row => row.values.length !== doc.sizes.length)) ctx.addIssue({ code: "custom", message: "尺寸须对应尺码列", path: ["measurements"] });
  for (const key of ["fabrics", "accessories", "measurements"] as const)
    if (new Set(doc[key].map(row => row.id)).size !== doc[key].length) ctx.addIssue({ code: "custom", message: "明细行不能重复", path: [key] });
  if (new Set(doc.images.map(row => row.attachmentId)).size !== doc.images.length) ctx.addIssue({ code: "custom", message: "图片不能重复", path: ["images"] });
});
export type InstructionDocument = z.infer<typeof InstructionDocumentSchema>;
export const SaveInstructionSchema = z.object({ expectedVersion: z.number().int().nonnegative(), orderVersion: z.number().int().positive(), document: InstructionDocumentSchema }).strict();
export const PublishInstructionSchema = z.object({ expectedVersion: z.number().int().positive(), orderVersion: z.number().int().positive() }).strict();
export const InstructionDateRequestSchema = z.object({ orderVersion: z.number().int().positive(), date: z.iso.date(), reason: text.min(1) }).strict();
export function initialInstruction(): InstructionDocument {
  return { styleName: "", category: "", season: "", fabricType: "", composition: "", date: null, process: "", remarks: "", patternMaker: "", preshrink: "待确认", shipSample: "", sewingRequirements: SEWING_REQUIREMENTS.join("\n"), comments: "", fabrics: [], accessories: [], images: [], unit: "inch", sizes: [], measurements: [] };
}
export function instructionErrors(doc: InstructionDocument, order: DigitalOrder): string[] {
  const errors: string[] = [];
  if (!doc.styleName || !doc.category || !doc.date) errors.push("请填写款名、类型、制单日期");
  if (doc.preshrink === "待确认") errors.push("请选择是否预缩");
  if (!doc.images.some(image => image.kind === "款图")) errors.push("请上传或沿用款图");
  if (order.lines.some(line => line.sizes.some(size => !doc.sizes.includes(size.size)))) errors.push("尺寸表须包含母单全部尺码");
  if (!doc.measurements.length) errors.push("请填写齐码尺寸");
  if (doc.fabrics.some(row => Object.keys(row.colors).some(id => !order.lines.some(line => line.lineId === id)))) errors.push("面料颜色必须对应母单款色");
  return errors;
}
export type InstructionSheet = {
  order: DigitalOrder; document: InstructionDocument; version: number; publishedVersion: number | null;
  versions: number[]; canEdit: boolean; cutStarted: boolean; merchandiserName: string | null;
  sourceRound: number | null; canApproveDate: boolean; printedBy: string;
  dateRequests: Array<{ requestId: string; legacy?: boolean; oldDate: string | null; date: string; reason: string; status: string }>;
};
