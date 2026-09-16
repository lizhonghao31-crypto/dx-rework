import { SUPPLIER_BATCH_COLUMNS } from "@dx-rework/contracts";
import { buildWorkbook } from "../reporting/xlsx-workbook.js";

export function supplierBatchTemplate(): Buffer {
  return buildWorkbook([
    { name: "供应商录入", textColumns: SUPPLIER_BATCH_COLUMNS.flatMap(([field], index) => field === "dailyCapacity" ? [] : [index]),
      rows: [SUPPLIER_BATCH_COLUMNS.map(([, label]) => label), SUPPLIER_BATCH_COLUMNS.map(() => "")] },
    { name: "填写说明", rows: [
      ["项目", "规则"],
      ["填写位置", "在供应商录入页第二行开始填写，不改列名和顺序；一次最多200行。"],
      ["供应商编码", "编码仅填目录中已有编码，名称须与编码一致；留空时按唯一名称＋类型识别，新供应商留空由系统生成编码。"],
      ["供应商类型", "加工厂、印绣花 / 洗水厂、面料商、其他供应商。"],
      ["启用状态", "启用或停用。留空：已有供应商保留原状态，新供应商默认启用。"],
      ["新增必填", "名称、类型、联系人、联系电话、地址、收款人、收款账号、开户行、可承接工艺。"],
      ["合同主体", "选填。仅当合同签约名称与供应商名称不同时填写；留空时合同自动使用供应商名称。"],
      ["补全资料", "空单元格不清除旧资料；可以仅填编码和要补充的字段。已有值不同需在系统确认。"],
      ["收款账号", "整列已设为文本；必须从原始账号填写，勿粘贴已舍入或科学计数法数字。"],
      ["可承接工艺", "多个工艺用顿号分隔，不能重复；上传工艺会与已有工艺合并，不删除旧工艺。"],
      ["常规日产能", "选填，1至10亿的整数；留空不清除原产能。"],
    ] },
  ]);
}
