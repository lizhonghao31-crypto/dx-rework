import { useState } from "react";
import { createRoot } from "react-dom/client";
import { SupplierCenterPage } from "../../apps/web/src/supplier-center-page.js";
import { MasterDataPage } from "../../apps/web/src/master-data-page.js";
import "../../packages/ui/src/tokens.css";
import "../../packages/ui/src/components.css";
import "../../apps/web/src/styles.css";

// Explicit offline fixture; all records and writes are synthetic.
const profiles = ["甲测试厂", "乙测试厂"].map((supplierName, index) => ({
  supplierId: `fixture-${index}`, supplierCode: `FAC_FIXTURE_${index}`, supplierType: "factory" as const,
  supplierName, version: 1, active: true, supportedCrafts: [], dailyCapacity: null,
  contractDataMissing: [], notes: "", contactPerson: null, contactPhone: null, address: null,
  changeReason: "合成测试记录", changedBy: "fixture-root", changedAt: "2026-09-07T00:00:00Z",
}));
let holdDetails = false;
let holdSave = false;
let failCreate = true;
let writes = 0;
const pending: Array<() => void> = [];
let notify = () => {};
const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (init?.method === "POST") {
    writes += 1;
    notify();
    const body = JSON.parse(String(init.body));
    if (url.endsWith("/versions")) {
      if (holdSave) await new Promise<void>((resolve) => pending.push(resolve));
      const profile = profiles.find((item) => url.includes(`/${item.supplierId}/`))!;
      if (profile.version !== body.expectedVersion) return reply({ error: { message: "供应商资料已更新，请刷新后重试" } }, 409);
      Object.assign(profile, body, { version: profile.version + 1 });
    } else {
      if (failCreate && writes === 2) return reply({ error: { message: "测试第二行失败" } }, 503);
      profiles.push({ ...profiles[0]!, ...body, supplierId: `created-${writes}`, version: 1 });
    }
    return reply({});
  }
  if (url.includes("suppliers?")) return reply(profiles);
  const profile = profiles.find((item) => url.includes(`/${item.supplierId}`));
  if (!profile) return reply({ error: { message: "测试对象不存在" } }, 404);
  const value = JSON.parse(JSON.stringify(url.endsWith("/history") ? [profile] : profile));
  if (holdDetails) await new Promise<void>((resolve) => pending.push(resolve));
  return reply(value);
};
function Fixture() {
  const [mode, setMode] = useState("center");
  const [, render] = useState(0);
  notify = () => render((value) => value + 1);
  const chooseCsv = (invalid: boolean) => {
    const input = document.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) return;
    const data = new DataTransfer();
    data.items.add(new File([`系统编码,供应商名称,供应商类型,启用状态\n,合成导入甲,加工厂,是\n,合成导入乙,加工厂,${invalid ? "错误" : "是"}\n,合成导入丙,加工厂,是`], "合成测试.csv", { type: "text/csv" }));
    input.files = data.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  };
  return <main style={{ padding: 16 }}>
    <section style={{ padding: 12, background: "white", marginBottom: 16 }} aria-label="离线测试控制">
      <b>合成数据回归 · 写请求 {writes} 次</b>
      <div><button onClick={() => { holdDetails = !holdDetails; render((n) => n + 1); }}>详情延迟：{holdDetails ? "开" : "关"}</button>
      <button onClick={() => { holdSave = !holdSave; render((n) => n + 1); }}>保存延迟：{holdSave ? "开" : "关"}</button>
      <button onClick={() => { holdDetails = false; holdSave = false; pending.splice(0).forEach((resolve) => resolve()); render((n) => n + 1); }}>完成挂起请求</button>
      <button onClick={() => { writes = 0; setMode(mode === "center" ? "import" : "center"); }}>切换测试页面</button>
      <button onClick={() => chooseCsv(false)}>选择有效测试文件</button><button onClick={() => chooseCsv(true)}>选择错误测试文件</button>
      <button onClick={() => { failCreate = false; }}>恢复导入服务</button></div>
    </section>
    {mode === "center" ? <SupplierCenterPage mode="manage" /> : <MasterDataPage view="suppliers" />}
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
