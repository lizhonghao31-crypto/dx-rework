import { useEffect, useState } from "react";
import { Button, StatusBadge, Surface } from "@dx-rework/ui";

import { createWebUrls } from "../url-contract.js";
import { Shell } from "./components.js";
import "./master-data-page.css";

const { apiUrl } = createWebUrls(import.meta.env.BASE_URL);

type Supplier = Readonly<{
  supplierId: string;
  supplierCode: string;
  supplierType: "factory" | "embroidery_washing" | "fabric" | "other";
  version: number;
  supplierName: string;
  active: boolean;
}>;

type Process = Readonly<{
  processId: string;
  processCode: string;
  version: number;
  processName: string;
  pricingUnit: "piece" | "hour";
  active: boolean;
}>;

const supplierTypeLabels: Record<Supplier["supplierType"], string> = {
  factory: "加工厂",
  embroidery_washing: "印绣花 / 洗水厂",
  fabric: "面料商",
  other: "其他供应商",
};

async function json<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(apiUrl(path), {
    credentials: "include",
    ...init,
    headers: {
      accept: "application/json",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
    throw new Error(body?.error?.message ?? `请求失败：${response.status}`);
  }
  if (response.status === 204) return undefined as T;
  return await response.json() as T;
}

const generatedCode = (prefix: string): string =>
  `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`;

export function MasterDataPage() {
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [processes, setProcesses] = useState<Process[]>([]);
  const [supplierName, setSupplierName] = useState("");
  const [supplierType, setSupplierType] = useState<Supplier["supplierType"]>("factory");
  const [processName, setProcessName] = useState("");
  const [pricingUnit, setPricingUnit] = useState<Process["pricingUnit"]>("piece");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const load = async () => {
    setError("");
    try {
      const [nextSuppliers, nextProcesses] = await Promise.all([
        json<Supplier[]>("master-data/suppliers?includeInactive=true"),
        json<Process[]>("master-data/processes?includeInactive=true"),
      ]);
      setSuppliers(nextSuppliers);
      setProcesses(nextProcesses);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "基础资料加载失败");
    }
  };

  useEffect(() => { void load(); }, []);

  const run = async (key: string, work: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(key);
    setError("");
    try {
      await work();
      await load();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "操作失败");
    } finally {
      setBusy("");
    }
  };

  const createSupplier = () => {
    const name = supplierName.trim();
    if (!name) {
      setError("请输入供应商名称。");
      return;
    }
    void run("create-supplier", async () => {
      await json("master-data/suppliers", {
        method: "POST",
        body: JSON.stringify({
          supplierCode: generatedCode("SUP"),
          supplierType,
          supplierName: name,
          active: true,
          changeReason: "新增业务基础资料",
        }),
      });
      setSupplierName("");
    });
  };

  const reviseSupplier = (supplier: Supplier, change: "rename" | "toggle") => {
    const nextName = change === "rename"
      ? window.prompt("请输入新的供应商名称", supplier.supplierName)?.trim()
      : supplier.supplierName;
    if (!nextName) return;
    const reason = window.prompt(change === "rename" ? "请输入修改原因" : `请输入${supplier.active ? "停用" : "恢复"}原因`)?.trim();
    if (!reason) return;
    void run(`supplier:${supplier.supplierId}`, () =>
      json(`master-data/suppliers/${supplier.supplierId}/versions`, {
        method: "POST",
        body: JSON.stringify({
          supplierName: nextName,
          active: change === "toggle" ? !supplier.active : supplier.active,
          changeReason: reason,
        }),
      }));
  };

  const createProcess = () => {
    const name = processName.trim();
    if (!name) {
      setError("请输入工序名称。");
      return;
    }
    void run("create-process", async () => {
      await json("master-data/processes", {
        method: "POST",
        body: JSON.stringify({
          processCode: generatedCode("PROC"),
          processName: name,
          pricingUnit,
          active: true,
          changeReason: "新增业务基础资料",
        }),
      });
      setProcessName("");
    });
  };

  const reviseProcess = (process: Process, change: "rename" | "toggle") => {
    const nextName = change === "rename"
      ? window.prompt("请输入新的工序名称", process.processName)?.trim()
      : process.processName;
    if (!nextName) return;
    const reason = window.prompt(change === "rename" ? "请输入修改原因" : `请输入${process.active ? "停用" : "恢复"}原因`)?.trim();
    if (!reason) return;
    void run(`process:${process.processId}`, () =>
      json(`master-data/processes/${process.processId}/versions`, {
        method: "POST",
        body: JSON.stringify({
          processName: nextName,
          pricingUnit: process.pricingUnit,
          active: change === "toggle" ? !process.active : process.active,
          changeReason: reason,
        }),
      }));
  };

  return (
    <Shell active="基础资料">
      <div className="master-data-shell">
        <div className="master-data-heading">
          <h1>基础资料</h1>
        </div>
        {error ? <p className="master-data-error" role="alert">{error}</p> : null}

        <div className="master-data-grid">
          <Surface className="master-data-panel">
            <h2>加工厂与供应商</h2>
            <div className="master-data-create">
              <input
                value={supplierName}
                placeholder="输入供应商名称"
                aria-label="供应商名称"
                onChange={(event) => setSupplierName(event.target.value)}
              />
              <select
                value={supplierType}
                aria-label="供应商类型"
                onChange={(event) => setSupplierType(event.target.value as Supplier["supplierType"])}
              >
                {Object.entries(supplierTypeLabels).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
              <Button disabled={Boolean(busy)} onClick={createSupplier}>
                {busy === "create-supplier" ? "新增中…" : "新增"}
              </Button>
            </div>
            <div className="master-data-list">
              {suppliers.length === 0 ? <p>暂无供应商。</p> : suppliers.map((supplier) => (
                <article key={supplier.supplierId} className="master-data-row">
                  <div>
                    <h3>{supplier.supplierName}</h3>
                    <p>{supplierTypeLabels[supplier.supplierType]} · 版本 {supplier.version}</p>
                  </div>
                  <StatusBadge tone={supplier.active ? "success" : "warning"}>{supplier.active ? "启用" : "停用"}</StatusBadge>
                  <div className="master-data-actions">
                    <Button disabled={Boolean(busy)} onClick={() => reviseSupplier(supplier, "rename")}>修改名称</Button>
                    <Button disabled={Boolean(busy)} onClick={() => reviseSupplier(supplier, "toggle")}>{supplier.active ? "停用" : "恢复"}</Button>
                  </div>
                </article>
              ))}
            </div>
          </Surface>

          <Surface className="master-data-panel">
            <h2>工序</h2>
            <div className="master-data-create">
              <input
                value={processName}
                placeholder="输入工序名称"
                aria-label="工序名称"
                onChange={(event) => setProcessName(event.target.value)}
              />
              <select
                value={pricingUnit}
                aria-label="默认计价单位"
                onChange={(event) => setPricingUnit(event.target.value as Process["pricingUnit"])}
              >
                <option value="piece">件</option>
                <option value="hour">小时</option>
              </select>
              <Button disabled={Boolean(busy)} onClick={createProcess}>
                {busy === "create-process" ? "新增中…" : "新增"}
              </Button>
            </div>
            <div className="master-data-list">
              {processes.length === 0 ? <p>暂无公共工序。</p> : processes.map((process) => (
                <article key={process.processId} className="master-data-row">
                  <div>
                    <h3>{process.processName}</h3>
                    <p>{process.pricingUnit === "piece" ? "按件" : "按小时"} · 版本 {process.version}</p>
                  </div>
                  <StatusBadge tone={process.active ? "success" : "warning"}>{process.active ? "启用" : "停用"}</StatusBadge>
                  <div className="master-data-actions">
                    <Button disabled={Boolean(busy)} onClick={() => reviseProcess(process, "rename")}>修改名称</Button>
                    <Button disabled={Boolean(busy)} onClick={() => reviseProcess(process, "toggle")}>{process.active ? "停用" : "恢复"}</Button>
                  </div>
                </article>
              ))}
            </div>
          </Surface>
        </div>
      </div>
    </Shell>
  );
}
