import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { installInternalNavigation } from "../../apps/web/src/internal-navigation.js";
import { SupplierDirectoryPage, SupplierMaintenancePage } from "../../apps/web/src/supplier-center-page.js";
import { MasterDataPage } from "../../apps/web/src/master-data-page.js";
import "../../packages/ui/src/tokens.css";
import "../../packages/ui/src/components.css";
import "../../apps/web/src/styles.css";

window.history.replaceState({}, "", "/rework/ui/suppliers/manage");
const currentRoute = () => window.location.pathname.replace(/^\/rework/, "");

// Explicit offline fixture; all records and writes are synthetic.
const profiles = ["合成测试 · 广州市达兴服装长期合作加工厂第一生产基地", "乙测试厂"].map((supplierName, index) => ({
  supplierId: `00000000-0000-4000-8000-00000000000${index}`, supplierCode: `FAC_FIXTURE_${index}`, supplierType: "factory" as const,
  supplierName, version: 1, active: true, supportedCrafts: ["车缝", "整烫"], dailyCapacity: 12800,
  contractDataMissing: index ? ["bankAccount"] : [], notes: "合成数据", contactPerson: "测试联系人", contactPhone: "020-00000000", address: "合成测试地址",
  payeeName: "测试收款人", bankAccount: index ? "" : "001234567890", bankName: "合成开户行",
  changeReason: "合成测试记录", changedBy: "fixture-root", changedAt: "2026-09-07T00:00:00Z",
}));
let holdDetails = false;
let holdSave = false;
let failCreate = true;
let failReadAfterSave = false;
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
    let saved;
    if (url.endsWith("/versions")) {
      if (holdSave) await new Promise<void>((resolve) => pending.push(resolve));
      const profile = profiles.find((item) => url.includes(`/${item.supplierId}/`))!;
      if (profile.version !== body.expectedVersion) return reply({ error: { message: "供应商资料已更新，请刷新后重试" } }, 409);
      Object.assign(profile, body, { version: profile.version + 1 });
      saved = profile;
    } else {
      if (failCreate && writes === 2) return reply({ error: { message: "测试第二行失败" } }, 503);
      saved = { ...profiles[0]!, ...body, supplierId: crypto.randomUUID(), version: 1 };
      profiles.push(saved);
    }
    return reply({ supplierId: saved.supplierId, version: saved.version }, 201);
  }
  if (failReadAfterSave && writes > 0) return reply({ error: { message: "合成测试：保存后读取失败" } }, 503);
  if (url.includes("suppliers?")) return reply(profiles);
  const profile = profiles.find((item) => url.includes(`/${item.supplierId}`));
  if (!profile) return reply({ error: { message: "测试对象不存在" } }, 404);
  const value = JSON.parse(JSON.stringify(url.endsWith("/history") ? [profile] : profile));
  if (holdDetails) await new Promise<void>((resolve) => pending.push(resolve));
  return reply(value);
};
function Fixture() {
  const [route, setRoute] = useState(currentRoute);
  useEffect(() => installInternalNavigation("/rework", () => setRoute(currentRoute())), []);
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
      <b>合成数据回归 · 写请求 {writes} 次</b><p>当前路径：{route}</p><a href="/rework/ui/fixture-other">离开供应商测试</a> · <a href="/rework/ui/suppliers">供应商目录</a> · <a href="/rework/ui/suppliers/manage">资料维护</a>
      <div><button onClick={() => { holdDetails = !holdDetails; render((n) => n + 1); }}>详情延迟：{holdDetails ? "开" : "关"}</button>
      <button onClick={() => { holdSave = !holdSave; render((n) => n + 1); }}>保存延迟：{holdSave ? "开" : "关"}</button>
      <button onClick={() => { holdDetails = false; holdSave = false; pending.splice(0).forEach((resolve) => resolve()); render((n) => n + 1); }}>完成挂起请求</button>
      <button onClick={() => { writes = 0; setMode(mode === "center" ? "import" : "center"); }}>切换测试页面</button>
      <button onClick={() => chooseCsv(false)}>选择有效测试文件</button><button onClick={() => chooseCsv(true)}>选择错误测试文件</button>
      <button onClick={() => { failCreate = false; }}>恢复导入服务</button></div>
      <button onClick={() => { failReadAfterSave = !failReadAfterSave; render(n => n + 1); }}>保存后读取失败：{failReadAfterSave ? "开" : "关"}</button>
    </section>
    {route === "/ui/fixture-other" ? <p>已离开供应商页面</p> : mode === "center" ? route === "/ui/suppliers" ? <SupplierDirectoryPage /> : <SupplierMaintenancePage /> : <MasterDataPage view="suppliers" />}
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
