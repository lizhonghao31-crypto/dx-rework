import type { Task } from "./types.js";

export const tasks: Task[] = [
  { id: "RW-2026-0801-012", title: "本厂责任待终审", meta: "¥512.25 · 超时 6h · 李总 / 伍总任一人", tone: "danger" },
  { id: "RW-2026-0731-026", title: "外发签字待回传", meta: "¥763.50 · 负责人：温燕红", tone: "warning" },
  { id: "RW-2026-0730-009", title: "责任证据待补齐", meta: "待补拍现场照片 · 张文豪跟进", tone: "info" },
  { id: "RW-2026-0729-006", title: "待 IE 审核", meta: "工序 / 价格 · 当前：邝飞", tone: "info" },
  { id: "RW-2026-0728-003", title: "工资已核对", meta: "N10-A 月结 · 欧阳俊珺", tone: "info" },
];

export const members = ["叶才华", "陈静", "林秀兰", "周美珍", "梁小玲", "赵海", "吴江"];
