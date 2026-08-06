import fs from "node:fs";

const requirements = [
  "单工序、单工人、加工厂全额承担并成功扣款",
  "多工序、多工人、分批上数、整单审核",
  "一个工序由多个责任方按比例承担",
  "多人同时上数时防止累计超量",
  "7人集体计件任务按成员快照均分，生成7条个人工资明细，个人明细合计严格等于组总额",
  "集体计件成员后续变化不影响已审核或已锁定的历史分摊",
  "工人上数被驳回、修改、重新提交",
  "主管审核后通过调整记录更正数量",
  "本厂承担由李总审批后，伍总收到结果知会且不重复审批",
  "本厂承担由伍总审批后，李总收到结果知会且不重复审批",
  "张文豪可以完整查看、判责和提交，但不能完成本厂承担最终审批",
  "三人使用相同Dashboard时看到相同指标、明细和异常，操作按钮按权限正确显示",
  "跟单修改责任/倍率并触发生产管理重新确认",
  "供应商部分扣款",
  "供应商扣款失败并将差额改为本厂承担",
  "临时工由李同生或授权人员代录",
  "月份人工锁定后只能生成下期调整",
  "非公司钉钉组织账号扫码后仍被拒绝",
  "员工离职/禁用后不能登录，但历史记录可查询",
  "移动端免密登录和电脑端扫码登录",
  "消息点击直达单据，重试不产生重复待办",
  "Excel明细金额与系统逐行舍入口径一致",
];

const file = process.argv[2];
if (!file) throw new Error("usage: validate.mjs MATRIX.json [EXPECTED_SHA]");
const expectedSha = process.argv[3] ?? process.env.TARGET_SHA ?? process.env.GIT_SHA ?? "";
if (expectedSha && !/^[0-9a-f]{40}$/.test(expectedSha)) {
  throw new Error("expected release SHA must be a full lowercase Git SHA");
}

const data = JSON.parse(fs.readFileSync(file, "utf8"));
if (data.routeId !== "PR-17" || data.requirementsBaseline !== "startup-requirements-v1.2 section 13") {
  throw new Error("route/baseline drift");
}
const items = data.items;
if (!Array.isArray(items) || items.length !== 22) throw new Error("matrix must contain exactly 22 items");

const allowed = new Set(["not_run", "passed", "failed", "blocked"]);
const required = [
  "requirement",
  "environment",
  "gitSha",
  "schemaVersion",
  "testDataIds",
  "roles",
  "steps",
  "expected",
  "actual",
  "evidenceRefs",
  "executor",
  "reviewer",
  "executedAt",
  "result",
  "defectLinks",
];
const placeholder = (value) => JSON.stringify(value).includes("TBD");

for (let index = 0; index < 22; index += 1) {
  const item = items[index];
  const id = `UAT-${String(index + 1).padStart(2, "0")}`;
  if (item.id !== id || item.requirement !== requirements[index]) {
    throw new Error(`${id} requirement/order drift`);
  }
  for (const key of required) {
    if (!(key in item) || item[key] === null || item[key] === "") throw new Error(`${id} empty ${key}`);
  }
  if (!allowed.has(item.result)) throw new Error(`${id} invalid result`);
  if (item.result === "not_run") continue;

  if (!expectedSha) throw new Error(`${id} executed evidence requires an expected release SHA`);
  if (!/^[0-9a-f]{40}$/.test(item.gitSha) || item.gitSha !== expectedSha) {
    throw new Error(`${id} evidence SHA does not match the release Head`);
  }
  if (!/^\d{4}_[a-z0-9_]+$/.test(item.schemaVersion) || !Number.isFinite(Date.parse(item.executedAt))) {
    throw new Error(`${id} invalid schema/time`);
  }
  for (const key of ["environment", "testDataIds", "roles", "steps", "expected", "actual", "executor", "reviewer"]) {
    if (placeholder(item[key]) || (Array.isArray(item[key]) && item[key].length === 0)) {
      throw new Error(`${id} placeholder ${key}`);
    }
  }
  if (item.executor === item.reviewer) throw new Error(`${id} requires independent executor/reviewer`);
  if (item.result === "passed" && !item.evidenceRefs.length) throw new Error(`${id} passed requires evidence`);
  if (item.result === "failed" && (!item.evidenceRefs.length || !item.defectLinks.length)) {
    throw new Error(`${id} failed requires evidence and defect`);
  }
  if (item.result === "blocked" && (!item.actual.trim() || (!item.evidenceRefs.length && !item.defectLinks.length))) {
    throw new Error(`${id} blocked requires reason and evidence/dependency`);
  }
}

console.log(`validated ${items.length} PR-17 acceptance items; executed evidence is bound to ${expectedSha || "template mode"}`);
