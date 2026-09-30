import { sourcingDatesValid, SOURCING_DATE_ORDER_ERROR, calculateSourcingOrderQuantity, findDuplicateSourcingLine } from "@dx-rework/contracts";
import { isNewSourcingPrice, sourcingDecisionNeedsReason } from "./sourcing-price-presentation.js";
import type { SubmissionIssue } from "./submission-validation.js";

type Line = { styleNo: string; alternateStyleNo: string; color: string; quantity: string };
type Price = { position: number; unitPrice: string };
export function validateSourcingCreate(input: {
  gender: string; styleName: string; estimatedCutPieceSendDate: string; deliveryDate: string;
  lineItems: readonly Line[]; daxingUnitPrice: string; imageCount: number; uploading: boolean; uploadFailed: boolean;
}): SubmissionIssue[] {
  const issues: SubmissionIssue[] = [];
  const add = (field: string, message: string) => issues.push({ fieldId: `sourcing-create-${field}`, message });
  if (!input.gender) add("gender", "请选择性别");
  if (!input.styleName.trim()) add("style", "请填写款式");
  if (!input.estimatedCutPieceSendDate) add("send-date", "请填写裁片发出日期");
  if (!input.deliveryDate) add("delivery-date", "请填写到工厂的交货日期");
  if (!sourcingDatesValid(input.estimatedCutPieceSendDate, input.deliveryDate)) add("delivery-date", SOURCING_DATE_ORDER_ERROR);
  if (!isNewSourcingPrice(input.daxingUnitPrice)) add("budget", "请填写大于0且最多2位有效小数的预算价");
  input.lineItems.forEach((line, index) => {
    if (!line.styleNo.trim() && !line.alternateStyleNo.trim()) add(`style-${index}`, `第 ${index + 1} 行须填写正式款号或代用款号`);
    if (!line.color.trim()) add(`color-${index}`, `第 ${index + 1} 行请填写颜色`);
    if (!/^\d+$/.test(line.quantity) || Number(line.quantity) < 1 || Number(line.quantity) > 10_000_000) {
      add(`quantity-${index}`, `第 ${index + 1} 行数量必须是1至10000000之间的整数`);
    }
  });
  if (!issues.some(issue => issue.fieldId.includes("quantity-"))) {
    try { calculateSourcingOrderQuantity(input.lineItems.map(line => ({ quantity: Number(line.quantity) }))); }
    catch { add("quantity-0", "订单总数量必须是1至10000000之间的整数"); }
  }
  const duplicate = findDuplicateSourcingLine(input.lineItems);
  if (duplicate) add(`style-${duplicate.index}`, duplicate.message);
  if (input.uploading) add("photos", "照片正在上传，请等待上传完成后提交");
  else if (input.uploadFailed) add("photos", "本次照片上传未完成，请重新选择图片上传成功后提交");
  else if (!input.imageCount) add("photos", "请至少上传一张订单照片");
  return issues;
}

export function validateSourcingPrices(kind: "quote" | "decision", lines: readonly Price[]): SubmissionIssue[] {
  return lines.filter(line => !isNewSourcingPrice(line.unitPrice)).map(line => ({
    fieldId: `sourcing-${kind}-price-${line.position}`,
    message: `第 ${line.position} 款请填写大于0且最多2位有效小数的${kind === "quote" ? "IE" : "生产"}价格`,
  }));
}

export function validateSourcingDecision(input: {
  supplierId: string; linePrices: readonly Price[]; decisionReason: string;
  cuttingProcess: string; cuttingProcessOther: string;
}, iePrices: readonly Price[], processes: readonly string[]): SubmissionIssue[] {
  const issues = validateSourcingPrices("decision", input.linePrices);
  if (!input.supplierId) issues.unshift({ fieldId: "sourcing-decision-factory", message: "请选择加工厂" });
  processes.forEach((process, index) => {
    if (!process.trim() || processes.findIndex(value => value.trim().toLowerCase() === process.trim().toLowerCase()) !== index) {
      issues.push({ fieldId: `sourcing-decision-process-${index}`, message: `第 ${index + 1} 项工艺及承包范围须填写完整，且不能重复` });
    }
  });
  if (input.cuttingProcess === "other" && !input.cuttingProcessOther.trim()) issues.push({ fieldId: "sourcing-decision-cutting-other", message: "请填写其它裁床工序" });
  if (sourcingDecisionNeedsReason(input.linePrices, iePrices) && !input.decisionReason.trim()) {
    issues.push({ fieldId: "sourcing-decision-reason", message: "价格高于 IE，请填写原因" });
  }
  return issues;
}
