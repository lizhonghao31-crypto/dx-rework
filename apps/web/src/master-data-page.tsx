import { useEffect, useMemo, useState } from "react";
import { Button, StatusBadge, Surface } from "@dx-rework/ui";

import { createWebUrls } from "../url-contract.js";
import { Shell } from "./components.js";
import { SystemManagementNavigation } from "./system-management-navigation.js";
import { promptInApp } from "./system-dialog.js";
import { downloadCsv, parseCsv } from "./csv.js";
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

type ImportAction = "create" | "update" | "skip" | "error";
type SupplierImportData = Readonly<{
  systemCode: string;
  supplierName: string;
  supplierType: Supplier["supplierType"];
  active: boolean;
}>;
type ProcessImportData = Readonly<{
  systemCode: string;
  processName: string;
  pricingUnit: Process["pricingUnit"];
  active: boolean;
}>;
type ImportPreviewRow = Readonly<{
  rowNumber: number;
  action: ImportAction;
  message: string;
  supplier?: SupplierImportData;
  process?: ProcessImportData;
}>;
type ImportPreview = Readonly<{
  kind: "supplier" | "process";
  filename: string;
  rows: readonly ImportPreviewRow[];
}>;

const supplierTypeLabels: Record<Supplier["supplierType"], string> = {
  factory: "加工厂",
  embroidery_washing: "印绣花 / 洗水厂",
  fabric: "面料商",
  other: "其他供应商",
};

const supplierTypeByLabel = new Map<string, Supplier["supplierType"]>([
  ["加工厂", "factory"],
  ["factory", "factory"],
  ["印绣花 / 洗水厂", "embroidery_washing"],
  ["印绣花/洗水厂", "embroidery_washing"],
  ["印绣花洗水", "embroidery_washing"],
  ["embroidery_washing", "embroidery_washing"],
  ["面料商", "fabric"],
  ["fabric", "fabric"],
  ["其他供应商", "other"],
  ["other", "other"],
]);

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

const supplierPrefix = (type: Supplier["supplierType"]): string => {
  if (type === "factory") return "FAC";
  if (type === "embroidery_washing") return "EMB";
  if (type === "fabric") return "FAB";
  return "SUP";
};

const normalized = (value: string): string => value.trim().toLocaleLowerCase("zh-CN");

const parseActive = (value: string): boolean | null => {
  const text = normalized(value);
  if (["是", "启用", "true", "1", "yes", "y"].includes(text)) return true;
  if (["否", "停用", "false", "0", "no", "n"].includes(text)) return false;
  return null;
};

const columnIndex = (headers: readonly string[], name: string): number =>
  headers.findIndex((header) => header.trim() === name);

const valueAt = (row: readonly string[], index: number): string =>
  index >= 0 ? (row[index] ?? "").trim() : "";

export function MasterDataPage() {
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [processes, setProcesses] = useState<Process[]>([]);
  const [supplierName, setSupplierName] = useState("");
  const [supplierType, setSupplierType] = useState<Supplier["supplierType"]>("factory");
  const [processName, setProcessName] = useState("");
  const [pricingUnit, setPricingUnit] = useState<Process["pricingUnit"]>("piece");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [importReason, setImportReason] = useState("批量初始化基础资料");

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
          supplierCode: generatedCode(supplierPrefix(supplierType)),
          supplierType,
          supplierName: name,
          active: true,
          changeReason: "新增业务基础资料",
        }),
      });
      setSupplierName("");
    });
  };

  const reviseSupplier = async (supplier: Supplier, change: "rename" | "toggle"): Promise<void> => {
    const nextName = change === "rename"
      ? (await promptInApp("请输入新的供应商名称", supplier.supplierName))?.trim()
      : supplier.supplierName;
    if (!nextName) return;
    const reason = (await promptInApp(change === "rename" ? "请输入修改原因" : `请输入${supplier.active ? "停用" : "恢复"}原因`))?.trim();
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

  const reviseProcess = async (process: Process, change: "rename" | "toggle"): Promise<void> => {
    const nextName = change === "rename"
      ? (await promptInApp("请输入新的工序名称", process.processName))?.trim()
      : process.processName;
    if (!nextName) return;
    const reason = (await promptInApp(change === "rename" ? "请输入修改原因" : `请输入${process.active ? "停用" : "恢复"}原因`))?.trim();
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

  const downloadSupplierTemplate = () => downloadCsv(
    "返工系统-供应商批量导入模板.csv",
    ["系统编码", "供应商名称", "供应商类型", "启用状态"],
    [],
  );
  const downloadProcessTemplate = () => downloadCsv(
    "返工系统-工序批量导入模板.csv",
    ["系统编码", "工序名称", "计价单位", "启用状态"],
    [],
  );
  const exportSuppliers = () => downloadCsv(
    "返工系统-供应商当前资料.csv",
    ["系统编码", "供应商名称", "供应商类型", "启用状态"],
    suppliers.map((supplier) => [
      supplier.supplierCode,
      supplier.supplierName,
      supplierTypeLabels[supplier.supplierType],
      supplier.active ? "是" : "否",
    ]),
  );
  const exportProcesses = () => downloadCsv(
    "返工系统-工序当前资料.csv",
    ["系统编码", "工序名称", "计价单位", "启用状态"],
    processes.map((process) => [
      process.processCode,
      process.processName,
      process.pricingUnit === "piece" ? "件" : "小时",
      process.active ? "是" : "否",
    ]),
  );

  const previewSupplierImport = (filename: string, rows: string[][]): ImportPreview => {
    const headers = rows[0] ?? [];
    const codeIndex = columnIndex(headers, "系统编码");
    const nameIndex = columnIndex(headers, "供应商名称");
    const typeIndex = columnIndex(headers, "供应商类型");
    const activeIndex = columnIndex(headers, "启用状态");
    if (nameIndex < 0 || typeIndex < 0 || activeIndex < 0) {
      throw new Error("供应商模板必须包含：供应商名称、供应商类型、启用状态。");
    }
    const seen = new Set<string>();
    const previewRows: ImportPreviewRow[] = rows.slice(1).map((row, offset) => {
      const rowNumber = offset + 2;
      const systemCode = valueAt(row, codeIndex);
      const supplierNameValue = valueAt(row, nameIndex);
      const typeText = valueAt(row, typeIndex);
      const supplierTypeValue = supplierTypeByLabel.get(typeText) ?? null;
      const activeValue = parseActive(valueAt(row, activeIndex));
      if (!supplierNameValue) return { rowNumber, action: "error", message: "供应商名称不能为空。" };
      if (!supplierTypeValue) return { rowNumber, action: "error", message: "供应商类型只能填写：加工厂、印绣花 / 洗水厂、面料商、其他供应商。" };
      if (activeValue === null) return { rowNumber, action: "error", message: "启用状态请填写“是”或“否”。" };
      const key = systemCode ? `code:${normalized(systemCode)}` : `new:${supplierTypeValue}:${normalized(supplierNameValue)}`;
      if (seen.has(key)) return { rowNumber, action: "error", message: "文件内存在重复记录。" };
      seen.add(key);
      const data: SupplierImportData = { systemCode, supplierName: supplierNameValue, supplierType: supplierTypeValue, active: activeValue };
      if (systemCode) {
        const existing = suppliers.find((supplier) => supplier.supplierCode === systemCode);
        if (!existing) return { rowNumber, action: "error", message: "系统编码不存在；新增记录请把系统编码留空。", supplier: data };
        if (existing.supplierType !== supplierTypeValue) return { rowNumber, action: "error", message: "既有供应商类型不能通过批量导入修改。", supplier: data };
        if (existing.supplierName === supplierNameValue && existing.active === activeValue) {
          return { rowNumber, action: "skip", message: "与当前资料一致。", supplier: data };
        }
        return { rowNumber, action: "update", message: "将生成新的资料版本。", supplier: data };
      }
      const sameName = suppliers.find((supplier) =>
        supplier.supplierType === supplierTypeValue && normalized(supplier.supplierName) === normalized(supplierNameValue));
      if (sameName) {
        if (sameName.active === activeValue) return { rowNumber, action: "skip", message: `已存在：${sameName.supplierCode}`, supplier: data };
        return { rowNumber, action: "error", message: `名称已存在（${sameName.supplierCode}）；请导出当前资料后用系统编码修改。`, supplier: data };
      }
      return { rowNumber, action: "create", message: "将自动生成系统编码。", supplier: data };
    });
    return { kind: "supplier", filename, rows: previewRows };
  };

  const previewProcessImport = (filename: string, rows: string[][]): ImportPreview => {
    const headers = rows[0] ?? [];
    const codeIndex = columnIndex(headers, "系统编码");
    const nameIndex = columnIndex(headers, "工序名称");
    const unitIndex = columnIndex(headers, "计价单位");
    const activeIndex = columnIndex(headers, "启用状态");
    if (nameIndex < 0 || unitIndex < 0 || activeIndex < 0) {
      throw new Error("工序模板必须包含：工序名称、计价单位、启用状态。");
    }
    const seen = new Set<string>();
    const previewRows: ImportPreviewRow[] = rows.slice(1).map((row, offset) => {
      const rowNumber = offset + 2;
      const systemCode = valueAt(row, codeIndex);
      const processNameValue = valueAt(row, nameIndex);
      const unitText = normalized(valueAt(row, unitIndex));
      const pricingUnitValue: Process["pricingUnit"] | null = ["件", "piece"].includes(unitText)
        ? "piece"
        : ["小时", "hour"].includes(unitText) ? "hour" : null;
      const activeValue = parseActive(valueAt(row, activeIndex));
      if (!processNameValue) return { rowNumber, action: "error", message: "工序名称不能为空。" };
      if (!pricingUnitValue) return { rowNumber, action: "error", message: "计价单位只能填写“件”或“小时”。" };
      if (activeValue === null) return { rowNumber, action: "error", message: "启用状态请填写“是”或“否”。" };
      const key = systemCode ? `code:${normalized(systemCode)}` : `new:${normalized(processNameValue)}`;
      if (seen.has(key)) return { rowNumber, action: "error", message: "文件内存在重复记录。" };
      seen.add(key);
      const data: ProcessImportData = { systemCode, processName: processNameValue, pricingUnit: pricingUnitValue, active: activeValue };
      if (systemCode) {
        const existing = processes.find((process) => process.processCode === systemCode);
        if (!existing) return { rowNumber, action: "error", message: "系统编码不存在；新增记录请把系统编码留空。", process: data };
        if (existing.processName === processNameValue && existing.pricingUnit === pricingUnitValue && existing.active === activeValue) {
          return { rowNumber, action: "skip", message: "与当前资料一致。", process: data };
        }
        return { rowNumber, action: "update", message: "将生成新的工序版本。", process: data };
      }
      const sameName = processes.find((process) => normalized(process.processName) === normalized(processNameValue));
      if (sameName) {
        if (sameName.pricingUnit === pricingUnitValue && sameName.active === activeValue) {
          return { rowNumber, action: "skip", message: `已存在：${sameName.processCode}`, process: data };
        }
        return { rowNumber, action: "error", message: `名称已存在（${sameName.processCode}）；请导出当前资料后用系统编码修改。`, process: data };
      }
      return { rowNumber, action: "create", message: "将自动生成系统编码。", process: data };
    });
    return { kind: "process", filename, rows: previewRows };
  };

  const readImportFile = async (kind: "supplier" | "process", file: File | null) => {
    if (!file) return;
    setError("");
    try {
      const rows = parseCsv(await file.text());
      if (rows.length < 1) throw new Error("导入文件为空。");
      setPreview(kind === "supplier"
        ? previewSupplierImport(file.name, rows)
        : previewProcessImport(file.name, rows));
    } catch (importError) {
      setPreview(null);
      setError(importError instanceof Error ? importError.message : "导入文件读取失败");
    }
  };

  const applyImport = async () => {
    if (!preview || busy) return;
    const reason = importReason.trim();
    if (!reason) {
      setError("确认导入前请填写操作原因。");
      return;
    }
    const actionable = preview.rows.filter((row) => row.action === "create" || row.action === "update");
    if (preview.rows.some((row) => row.action === "error")) {
      setError("预检仍有错误行，请先修改文件后重新上传。");
      return;
    }
    setBusy("batch-import");
    setError("");
    try {
      for (const row of actionable) {
        if (preview.kind === "supplier" && row.supplier) {
          if (row.action === "create") {
            await json("master-data/suppliers", {
              method: "POST",
              body: JSON.stringify({
                supplierCode: generatedCode(supplierPrefix(row.supplier.supplierType)),
                supplierType: row.supplier.supplierType,
                supplierName: row.supplier.supplierName,
                active: row.supplier.active,
                changeReason: reason,
              }),
            });
          } else {
            const existing = suppliers.find((supplier) => supplier.supplierCode === row.supplier?.systemCode);
            if (!existing) throw new Error(`第 ${row.rowNumber} 行对应的供应商已不存在，请重新预检。`);
            await json(`master-data/suppliers/${existing.supplierId}/versions`, {
              method: "POST",
              body: JSON.stringify({
                supplierName: row.supplier.supplierName,
                active: row.supplier.active,
                changeReason: reason,
              }),
            });
          }
        }
        if (preview.kind === "process" && row.process) {
          if (row.action === "create") {
            await json("master-data/processes", {
              method: "POST",
              body: JSON.stringify({
                processCode: generatedCode("PROC"),
                processName: row.process.processName,
                pricingUnit: row.process.pricingUnit,
                active: row.process.active,
                changeReason: reason,
              }),
            });
          } else {
            const existing = processes.find((process) => process.processCode === row.process?.systemCode);
            if (!existing) throw new Error(`第 ${row.rowNumber} 行对应的工序已不存在，请重新预检。`);
            await json(`master-data/processes/${existing.processId}/versions`, {
              method: "POST",
              body: JSON.stringify({
                processName: row.process.processName,
                pricingUnit: row.process.pricingUnit,
                active: row.process.active,
                changeReason: reason,
              }),
            });
          }
        }
      }
      await load();
      setPreview(null);
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : "批量导入失败");
    } finally {
      setBusy("");
    }
  };

  const previewSummary = useMemo(() => {
    if (!preview) return null;
    return {
      create: preview.rows.filter((row) => row.action === "create").length,
      update: preview.rows.filter((row) => row.action === "update").length,
      skip: preview.rows.filter((row) => row.action === "skip").length,
      error: preview.rows.filter((row) => row.action === "error").length,
    };
  }, [preview]);

  return (
    <Shell active="基础资料">
      <header className="page-heading">
        <div>
          <h1>基础资料</h1>
          <p>维护加工厂、供应商和公共工序资料。</p>
        </div>
      </header>
      <Surface className="admin-card"><SystemManagementNavigation active="master-data" /></Surface>
      <div className="master-data-shell">
        {error ? <p className="master-data-error" role="alert">{error}</p> : null}

        <div className="master-data-grid">
          <Surface className="master-data-panel">
            <div className="master-data-section-heading" id="factories">
              <h2>加工厂与供应商</h2>
              <div className="master-data-batch-actions">
                <Button disabled={Boolean(busy)} onClick={downloadSupplierTemplate}>下载导入模板</Button>
                <Button disabled={Boolean(busy)} onClick={exportSuppliers}>导出当前资料</Button>
                <label className="master-data-file-button">
                  <span>上传批量导入</span>
                  <input
                    type="file"
                    accept=".csv,text/csv,application/vnd.ms-excel"
                    disabled={Boolean(busy)}
                    onChange={(event) => {
                      void readImportFile("supplier", event.target.files?.[0] ?? null);
                      event.currentTarget.value = "";
                    }}
                  />
                </label>
              </div>
            </div>
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
                    <p>{supplier.supplierCode} · {supplierTypeLabels[supplier.supplierType]} · 版本 {supplier.version}</p>
                  </div>
                  <StatusBadge tone={supplier.active ? "success" : "warning"}>{supplier.active ? "启用" : "停用"}</StatusBadge>
                  <div className="master-data-actions">
                    <Button disabled={Boolean(busy)} onClick={() => void reviseSupplier(supplier, "rename")}>修改名称</Button>
                    <Button disabled={Boolean(busy)} onClick={() => void reviseSupplier(supplier, "toggle")}>{supplier.active ? "停用" : "恢复"}</Button>
                  </div>
                </article>
              ))}
            </div>
          </Surface>

          <Surface className="master-data-panel">
            <div className="master-data-section-heading" id="processes">
              <h2>工序</h2>
              <div className="master-data-batch-actions">
                <Button disabled={Boolean(busy)} onClick={downloadProcessTemplate}>下载导入模板</Button>
                <Button disabled={Boolean(busy)} onClick={exportProcesses}>导出当前资料</Button>
                <label className="master-data-file-button">
                  <span>上传批量导入</span>
                  <input
                    type="file"
                    accept=".csv,text/csv,application/vnd.ms-excel"
                    disabled={Boolean(busy)}
                    onChange={(event) => {
                      void readImportFile("process", event.target.files?.[0] ?? null);
                      event.currentTarget.value = "";
                    }}
                  />
                </label>
              </div>
            </div>
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
                    <p>{process.processCode} · {process.pricingUnit === "piece" ? "按件" : "按小时"} · 版本 {process.version}</p>
                  </div>
                  <StatusBadge tone={process.active ? "success" : "warning"}>{process.active ? "启用" : "停用"}</StatusBadge>
                  <div className="master-data-actions">
                    <Button disabled={Boolean(busy)} onClick={() => void reviseProcess(process, "rename")}>修改名称</Button>
                    <Button disabled={Boolean(busy)} onClick={() => void reviseProcess(process, "toggle")}>{process.active ? "停用" : "恢复"}</Button>
                  </div>
                </article>
              ))}
            </div>
          </Surface>
        </div>

        {preview && previewSummary ? (
          <Surface className="master-data-import-preview">
            <div className="master-data-section-heading">
              <div>
                <h2>批量导入预检</h2>
                <p>{preview.filename}</p>
              </div>
              <Button disabled={Boolean(busy)} onClick={() => setPreview(null)}>关闭</Button>
            </div>
            <div className="master-data-import-summary">
              <span>新增 {previewSummary.create}</span>
              <span>更新 {previewSummary.update}</span>
              <span>跳过 {previewSummary.skip}</span>
              <span>错误 {previewSummary.error}</span>
            </div>
            <div className="master-data-import-list">
              {preview.rows.map((row) => (
                <div className={`master-data-import-row master-data-import-row--${row.action}`} key={row.rowNumber}>
                  <b>第 {row.rowNumber} 行</b>
                  <span>{row.supplier?.supplierName ?? row.process?.processName ?? "—"}</span>
                  <span>{row.message}</span>
                </div>
              ))}
            </div>
            <label className="master-data-import-reason">
              操作原因
              <input value={importReason} maxLength={500} onChange={(event) => setImportReason(event.target.value)} />
            </label>
            <Button
              variant="primary"
              disabled={Boolean(busy) || previewSummary.error > 0}
              onClick={() => void applyImport()}
            >
              {busy === "batch-import" ? "导入中…" : "确认导入"}
            </Button>
          </Surface>
        ) : null}
      </div>
    </Shell>
  );
}
