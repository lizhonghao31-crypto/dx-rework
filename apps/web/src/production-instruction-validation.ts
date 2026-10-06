import { InstructionDocumentSchema, instructionErrors, type InstructionDocument } from "@dx-rework/contracts/production-instruction";
import type { DigitalOrder } from "@dx-rework/contracts/digital-production";
import type { DocumentIssue } from "./document-editor.js";

export const instructionTabs = { main: "生产主单", fabrics: "面料单", sewing: "车缝辅料", packaging: "包装辅料", images: "工艺单", measurements: "尺寸表" } as const;
export type InstructionTab = keyof typeof instructionTabs;
export type InstructionIssue = DocumentIssue & { tab: InstructionTab };
export const instructionLabels = { styleName: "款名", category: "类型", season: "年份季节", fabricType: "面料类型", composition: "款式成分", process: "加工工序", remarks: "备注", patternMaker: "纸样师", shipSample: "船样尺码与数量要求", sewingRequirements: "车缝基本要求", comments: "评语", date: "制单日期", preshrink: "预缩", secondaryCraft: "大货印绣路线" } as const;
export const instructionAccessoryLabels = { garmentColors: "成衣颜色", materialColor: "物料颜色", name: "辅料名称", category: "物料类型", part: "使用部位", specification: "规格", consumption: "单件用量", remarks: "备注" } as const;

/** Present the existing schema and publish errors at stable fields; no additional business rules. */
export function instructionIssues(doc: InstructionDocument, order: DigitalOrder, publish = false): InstructionIssue[] {
  const issues: InstructionIssue[] = [];
  const parsed = InstructionDocumentSchema.safeParse(doc);
  if (!parsed.success) for (const issue of parsed.error.issues) {
    const key = String(issue.path[0]);
    let tab: InstructionTab = "main", id = `instruction-${key}`, label: string = instructionLabels[key as keyof typeof instructionLabels] ?? key;
    const index = typeof issue.path[1] === "number" ? issue.path[1] : undefined;
    if (key === "fabrics") {
      tab = "fabrics"; label = "面料单";
      const row = index === undefined ? undefined : doc.fabrics[index];
      if (row) { const field = issue.path[2] === "colors" ? `color-${String(issue.path[3])}` : String(issue.path[2] ?? "name"); id = `instruction-fabric-${row.id}-${field}`; label += ` · 第${index! + 1}行 · ${row.name || "面料"}`; }
    } else if (key === "accessories") {
      const row = index === undefined ? undefined : doc.accessories[index];
      tab = row?.group === "包装" ? "packaging" : "sewing"; id = `instruction-${tab}`; label = instructionTabs[tab];
      if (row) { const field = String(issue.path[2] ?? "name"); id = `instruction-accessory-${row.id}-${field}`; label += ` · ${row.name || `第${index! + 1}行`} · ${instructionAccessoryLabels[field as keyof typeof instructionAccessoryLabels] ?? field}`; }
    } else if (key === "images") {
      tab = "images"; id = "instruction-images"; label = "工艺单 · 图片";
      const row = index === undefined ? undefined : doc.images[index];
      if (row) { id = `instruction-image-${row.attachmentId}-description`; label += ` · ${row.kind} ${index! + 1}`; }
    } else if (["sizes", "unit", "measurements"].includes(key)) {
      tab = "measurements"; id = key === "unit" ? "instruction-unit" : "instruction-measurements"; label = "尺寸表";
      const row = key === "measurements" && index !== undefined ? doc.measurements[index] : undefined;
      if (row) { const field = issue.path[2] === "values" ? `value-${Number(issue.path[3] ?? 0)}` : String(issue.path[2] ?? "name"); id = `instruction-measurement-${row.id}-${field}`; label += ` · ${row.name || `第${index! + 1}行`} · ${issue.path[2] === "values" ? doc.sizes[Number(issue.path[3] ?? 0)] : field === "name" ? "部位" : field === "tolerance" ? "公差" : "量法"}`; }
    }
    issues.push({ id, label, tab, message: issue.message });
  }
  if (!publish || !parsed.success) return issues;
  for (const message of instructionErrors(parsed.data, order)) {
    if (message === "请填写款名、类型、制单日期") {
      for (const key of ["styleName", "category", "date"] as const) if (!parsed.data[key]) issues.push({ id: `instruction-${key}`, label: `生产主单 · ${instructionLabels[key]}`, tab: "main", message });
    } else if (message === "请选择是否预缩") issues.push({ id: "instruction-preshrink", label: "生产主单 · 预缩", tab: "main", message });
    else if (message === "请上传或沿用款图") issues.push({ id: "instruction-upload", label: "工艺单 · 款图", tab: "images", message });
    else if (message === "面料颜色必须对应母单款色") issues.push({ id: "instruction-fabrics", label: "面料单 · 款色对应", tab: "fabrics", message });
    else if (message === "每个尺寸项目须有名称，所有尺码须填写尺寸值") {
      for (const row of parsed.data.measurements) {
        if (!row.name) issues.push({ id: `instruction-measurement-${row.id}-name`, label: "尺寸表 · 部位", tab: "measurements", message });
        row.values.forEach((value, index) => { if (!value) issues.push({ id: `instruction-measurement-${row.id}-value-${index}`, label: `尺寸表 · ${row.name || "未命名部位"} · ${doc.sizes[index]}`, tab: "measurements", message }); });
      }
    } else issues.push({ id: "instruction-measurements", label: "尺寸表", tab: "measurements", message });
  }
  return issues;
}
