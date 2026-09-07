import { NavigationIcon } from "./navigation-icons.js";
import { formatBusinessDecimal } from "@dx-rework/contracts/business-display";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button, StatusBadge, Surface } from "@dx-rework/ui";

import { createWebUrls } from "../url-contract.js";
import { createClientRequestId } from "./client-request-id.js";
import { Shell } from "./components.js";
import { ListPagination, usePaginatedItems } from "./list-pagination.js";
import { SystemManagementNavigation } from "./system-management-navigation.js";
import { verifySession } from "./auth.js";
import { alertInApp, promptInApp } from "./system-dialog.js";
import { canApplySupplierImport, executeSupplierImport, type SupplierImportData, type SupplierImportResult } from "./supplier-import-safety.js";
import { downloadCsv, parseCsv } from "./csv.js";
import "./master-data-page.css";

const { apiUrl, pageUrl } = createWebUrls(import.meta.env.BASE_URL);

type Craft = Readonly<{
  craftId: string;
  craftCode: string;
  version: number;
  craftName: string;
  active: boolean;
  createdAt: string;
}>;

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
  defaultWorkerPersonIds: string[];
}>;

type ProcessPage = Readonly<{
  items: Process[];
  page: number;
  pageSize: 15;
  totalCount: number;
  totalPages: number;
}>;

type ProcessDefaultWorkerCandidate = Readonly<{
  personId: string;
  personType: "internal" | "temporary";
  displayName: string;
  temporaryRemark: string | null;
}>;

type ImportAction = "create" | "update" | "skip" | "error";
type ProcessImportData = Readonly<{
  systemCode: string;
  processId?: string;
  processName: string;
  pricingUnit: Process["pricingUnit"];
  active: boolean;
}>;
type ImportPreviewRow = Readonly<{
  rowNumber: number;
  action: ImportAction;
  message: string;
  supplier?: SupplierImportData;
  result?: SupplierImportResult;
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

const processCatalogPath = (query: string, page = 1): string => {
  const parameters = new URLSearchParams({ includeInactive: "true" });
  if (query) parameters.set("q", query);
  parameters.set("page", String(page));
  return `master-data/process-catalog?${parameters.toString()}`;
};

const generatedCode = (prefix: string): string =>
  `${prefix}_${createClientRequestId().replaceAll("-", "").slice(0, 12).toUpperCase()}`;

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

export type MasterDataView = "crafts" | "suppliers" | "processes";

export function MasterDataPage({ view = "crafts" }: { view?: MasterDataView }) {
  const [crafts, setCrafts] = useState<Craft[]>([]);
  const [craftName, setCraftName] = useState("");
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [processes, setProcesses] = useState<Process[]>([]);
  const [processDefaultWorkerCandidates, setProcessDefaultWorkerCandidates] = useState<ProcessDefaultWorkerCandidate[]>([]);
  const [supplierName, setSupplierName] = useState("");
  const [supplierType, setSupplierType] = useState<Supplier["supplierType"]>("factory");
  const [processName, setProcessName] = useState("");
  const [pricingUnit, setPricingUnit] = useState<Process["pricingUnit"]>("piece");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const importLock = useRef(false);
  const [importReason, setImportReason] = useState("批量初始化基础资料");
  const [editingProcessRosterId, setEditingProcessRosterId] = useState("");
  const [processRosterDraft, setProcessRosterDraft] = useState<string[]>([]);
  const [processRosterSearch, setProcessRosterSearch] = useState("");
  const [processSearch, setProcessSearch] = useState("");
  const [appliedProcessSearch, setAppliedProcessSearch] = useState("");
  const [processPage, setProcessPage] = useState(1);
  const [processTotalPages, setProcessTotalPages] = useState(1);
  const [processPageLoading, setProcessPageLoading] = useState(false);
  const [canWriteSuppliers, setCanWriteSuppliers] = useState(false);

  const load = async () => {
    setError("");
    try {
      if (view === "crafts") {
        setCrafts(await json<Craft[]>("master-data/crafts?includeInactive=true"));
      } else if (view === "suppliers") {
        const [nextSuppliers, session] = await Promise.all([
          json<Supplier[]>("master-data/suppliers?includeInactive=true"),
          verifySession(),
        ]);
        setSuppliers(nextSuppliers);
        setCanWriteSuppliers(session !== "denied" && session.user.isRoot === true);
      } else {
        const [nextProcessPage, nextProcessDefaultWorkerCandidates] = await Promise.all([
          json<ProcessPage>(processCatalogPath(appliedProcessSearch)),
          json<ProcessDefaultWorkerCandidate[]>("master-data/process-default-worker-candidates"),
        ]);
        setProcesses(nextProcessPage.items);
        setProcessPage(nextProcessPage.page);
        setProcessTotalPages(nextProcessPage.totalPages);
        setProcessDefaultWorkerCandidates(nextProcessDefaultWorkerCandidates);
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : view === "crafts" ? "工艺数据库加载失败" : view === "processes" ? "工序数据库加载失败" : "供应商资料加载失败");
    }
  };

  useEffect(() => { void load(); }, [view]);

  const showProcessPage = async (query: string, pageNumber: number) => {
    if (processPageLoading || busy) return;
    setProcessPageLoading(true);
    setBusy("process-page");
    setError("");
    try {
      const nextPage = await json<ProcessPage>(processCatalogPath(query, pageNumber));
      setProcesses(nextPage.items);
      setProcessPage(nextPage.page);
      setProcessTotalPages(nextPage.totalPages);
      setAppliedProcessSearch(query);
      setEditingProcessRosterId("");
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "工序目录加载失败");
    } finally {
      setProcessPageLoading(false);
      setBusy("");
    }
  };

  const applyProcessSearch = (): void => {
    void showProcessPage(processSearch.trim(), 1);
  };

  const clearProcessSearch = (): void => {
    setProcessSearch("");
    void showProcessPage("", 1);
  };

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

  const createCraft = async () => {
    const name = craftName.trim();
    if (!name) {
      const issue = "请输入工艺名称。";
      setError(issue);
      await alertInApp(issue, { title: "工艺暂不能新增", confirmLabel: "知道了" });
      return;
    }
    void run("create-craft", async () => {
      await json("master-data/crafts/ensure", {
        method: "POST",
        body: JSON.stringify({ craftNames: [name] }),
      });
      setCraftName("");
    });
  };

  const reviseCraft = async (craft: Craft, change: "rename" | "toggle"): Promise<void> => {
    const nextName = change === "rename"
      ? (await promptInApp("请输入新的工艺名称", craft.craftName))?.trim()
      : craft.craftName;
    if (!nextName) return;
    const reason = (await promptInApp(change === "rename" ? "请输入修改原因" : `请输入${craft.active ? "停用" : "恢复"}原因`))?.trim();
    if (!reason) return;
    void run(`craft:${craft.craftId}`, () =>
      json(`master-data/crafts/${craft.craftId}/versions`, {
        method: "POST",
        body: JSON.stringify({
          craftName: nextName,
          active: change === "toggle" ? !craft.active : craft.active,
          changeReason: reason,
        }),
      }));
  };

  const createSupplier = async () => {
    const name = supplierName.trim();
    if (!name) {
      const issue = "请输入供应商名称。";
      setError(issue);
      await alertInApp(issue, { title: "供应商暂不能新增", confirmLabel: "知道了" });
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
          expectedVersion: supplier.version,
          changeReason: reason,
        }),
      }));
  };

  const createProcess = async () => {
    const name = processName.trim();
    if (!name) {
      const issue = "请输入工序名称。";
      setError(issue);
      await alertInApp(issue, { title: "工序暂不能新增", confirmLabel: "知道了" });
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

  const openProcessRoster = (process: Process): void => {
    if (editingProcessRosterId === process.processId) {
      setEditingProcessRosterId("");
      return;
    }
    setEditingProcessRosterId(process.processId);
    setProcessRosterDraft([...process.defaultWorkerPersonIds]);
    setProcessRosterSearch("");
  };

  const toggleProcessRosterPerson = (personId: string, checked: boolean): void => {
    setProcessRosterDraft((current) => checked
      ? current.includes(personId) ? current : [...current, personId]
      : current.filter((id) => id !== personId));
  };

  const saveProcessRoster = (process: Process): void => {
    void run(`process-roster:${process.processId}`, async () => {
      await json(`master-data/processes/${process.processId}/default-workers`, {
        method: "PUT",
        body: JSON.stringify({
          personIds: processRosterDraft,
          changeReason: "工序页面维护默认候选人",
        }),
      });
      setEditingProcessRosterId("");
    });
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
  const loadAllProcesses = () => json<Process[]>("master-data/processes?includeInactive=true");

  const exportProcesses = async (): Promise<void> => {
    if (busy) return;
    setBusy("export-processes");
    setError("");
    try {
      const catalog = await loadAllProcesses();
      downloadCsv(
        "返工系统-工序当前资料.csv",
        ["系统编码", "工序名称", "计价单位", "启用状态"],
        catalog.map((process) => [
          process.processCode,
          process.processName,
          process.pricingUnit === "piece" ? "件" : "小时",
          process.active ? "是" : "否",
        ]),
      );
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : "工序资料导出失败");
    } finally {
      setBusy("");
    }
  };

  const previewSupplierImport = (filename: string, rows: string[][], catalog: readonly Supplier[]): ImportPreview => {
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
        const existing = catalog.find((supplier) => supplier.supplierCode === systemCode);
        if (!existing) return { rowNumber, action: "error", message: "系统编码不存在；新增记录请把系统编码留空。", supplier: data };
        if (existing.supplierType !== supplierTypeValue) return { rowNumber, action: "error", message: "既有供应商类型不能通过批量导入修改。", supplier: data };
        if (existing.supplierName === supplierNameValue && existing.active === activeValue) {
          return { rowNumber, action: "skip", message: "与当前资料一致。", supplier: data };
        }
        return { rowNumber, action: "update", message: `将更新版本 ${existing.version}。`, supplier: { ...data, supplierId: existing.supplierId, expectedVersion: existing.version } };
      }
      const sameName = catalog.find((supplier) =>
        supplier.supplierType === supplierTypeValue && normalized(supplier.supplierName) === normalized(supplierNameValue));
      if (sameName) {
        if (sameName.active === activeValue) return { rowNumber, action: "skip", message: `已存在：${sameName.supplierCode}`, supplier: data };
        return { rowNumber, action: "error", message: `名称已存在（${sameName.supplierCode}）；请导出当前资料后用系统编码修改。`, supplier: data };
      }
      const frozenCode = generatedCode(supplierPrefix(supplierTypeValue));
      return { rowNumber, action: "create", message: `新增编码：${frozenCode}`, supplier: { ...data, systemCode: frozenCode } };
    });
    return { kind: "supplier", filename, rows: previewRows };
  };

  const previewProcessImport = (filename: string, rows: string[][], catalog: readonly Process[]): ImportPreview => {
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
        const existing = catalog.find((process) => process.processCode === systemCode);
        if (!existing) return { rowNumber, action: "error", message: "系统编码不存在；新增记录请把系统编码留空。", process: data };
        const existingData = { ...data, processId: existing.processId };
        if (existing.processName === processNameValue && existing.pricingUnit === pricingUnitValue && existing.active === activeValue) {
          return { rowNumber, action: "skip", message: "与当前资料一致。", process: existingData };
        }
        return { rowNumber, action: "update", message: "将生成新的工序版本。", process: existingData };
      }
      const sameName = catalog.find((process) => normalized(process.processName) === normalized(processNameValue));
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
    if (!file || busy || importLock.current) return;
    importLock.current = true;
    setBusy("import-preflight");
    setError("");
    try {
      const rows = parseCsv(await file.text());
      if (rows.length < 1) throw new Error("导入文件为空。");
      setPreview(kind === "supplier"
        ? previewSupplierImport(file.name, rows, await json<Supplier[]>("master-data/suppliers?includeInactive=true"))
        : previewProcessImport(file.name, rows, await loadAllProcesses()));
    } catch (importError) {
      setPreview(null);
      setError(importError instanceof Error ? importError.message : "导入文件读取失败");
    } finally {
      importLock.current = false;
      setBusy("");
    }
  };

  const applyImport = async () => {
    if (!preview || busy || importLock.current) return;
    if (preview.kind === "supplier" && !canWriteSuppliers) return;
    const reason = importReason.trim();
    if (!reason) {
      const issue = "确认导入前请填写操作原因。";
      setError(issue);
      await alertInApp(issue, { title: "批量资料暂不能导入", confirmLabel: "知道了" });
      return;
    }
    const actionable = preview.rows.filter((row) => row.action === "create" || row.action === "update");
    if (preview.rows.some((row) => row.action === "error")) {
      const issue = "预检仍有错误行，请先修改文件后重新上传。";
      setError(issue);
      await alertInApp(issue, { title: "批量资料暂不能导入", confirmLabel: "知道了" });
      return;
    }
    if (actionable.length === 0) {
      const issue = "当前预检没有需要新增或更新的记录。";
      setError(issue);
      await alertInApp(issue, { title: "批量资料暂不能导入", confirmLabel: "知道了" });
      return;
    }
    if (preview.kind === "supplier" && !canApplySupplierImport(preview.rows, reason)) return;
    importLock.current = true;
    setBusy("batch-import");
    setError("");
    try {
      if (preview.kind === "supplier") {
        await executeSupplierImport(preview.rows, reason, {
          list: () => json<Supplier[]>("master-data/suppliers?includeInactive=true"),
          create: (data, changeReason) => json("master-data/suppliers", {
            method: "POST",
            body: JSON.stringify({ supplierCode: data.systemCode, supplierType: data.supplierType,
              supplierName: data.supplierName, active: data.active, changeReason }),
          }),
          update: (data, changeReason) => json(`master-data/suppliers/${data.supplierId}/versions`, {
            method: "POST",
            body: JSON.stringify({ supplierName: data.supplierName, active: data.active,
              expectedVersion: data.expectedVersion, changeReason }),
          }),
        }, (rowNumber, result) => setPreview((current) => current && current.kind === "supplier"
          ? { ...current, rows: current.rows.map((row) => row.rowNumber === rowNumber ? { ...row, result } : row) }
          : current));
        await load();
        return;
      }
      for (const row of actionable) {
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
            if (!row.process.processId) throw new Error(`第 ${row.rowNumber} 行对应的工序缺少预检标识，请重新预检。`);
            await json(`master-data/processes/${row.process.processId}/versions`, {
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
      importLock.current = false;
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
  const craftPage = usePaginatedItems(crafts, view);
  const supplierPage = usePaginatedItems(suppliers, view);

  return (
    <Shell active="基础资料">
      <header className="page-heading">
        <div>
          <h1><NavigationIcon route="/ui/master-data" size="title" />{view === "crafts" ? "工艺数据库" : view === "processes" ? "工序数据库" : "工厂与供应商"}</h1>
          <p>{view === "crafts" ? "沉淀外发定价与选厂使用的工艺；业务页直接录入后自动同步。" : view === "processes" ? "维护返工使用的公共工序、计价单位和默认候选人。" : "维护加工厂及其他供应商资料。"}</p>
        </div>
      </header>
      <Surface className="admin-card"><SystemManagementNavigation active="master-data" /></Surface>
      <nav className="master-data-view-tabs" aria-label="基础资料数据库">
        <a className={view === "crafts" ? "active" : ""} href={`${pageUrl("ui/master-data")}?view=crafts`}>工艺数据库</a>
        <a className={view === "processes" ? "active" : ""} href={`${pageUrl("ui/master-data")}?view=processes`}>工序数据库</a>
        <a href={pageUrl("ui/suppliers")}>供应商中心</a>
      </nav>
      <div className="master-data-shell">
        {error ? <p className="master-data-error" role="alert">{error}</p> : null}

        <div className="master-data-grid master-data-grid--single">
          {view === "crafts" ? <Surface className="master-data-panel">
            <div className="master-data-section-heading" id="crafts">
              <div>
                <h2>外发工艺</h2>
                <p>外发跟单在创建订单时可直接录入新工艺；系统自动建档，后续订单可直接搜索复用。</p>
              </div>
            </div>
            <div className="master-data-create">
              <input
                value={craftName}
                maxLength={100}
                placeholder="输入新的外发工艺名称"
                aria-label="外发工艺名称"
                onChange={(event) => setCraftName(event.target.value)}
              />
              <Button data-ready={craftName.trim() ? "true" : "false"} disabled={Boolean(busy)} onClick={() => void createCraft()}>
                {busy === "create-craft" ? "新增中…" : "新增工艺"}
              </Button>
            </div>
            <div className="master-data-list">
              {crafts.length === 0 ? <p>暂无外发工艺；提交第一张外发订单时也会自动建档。</p> : craftPage.items.map((craft) => (
                <article key={craft.craftId} className="master-data-row">
                  <div>
                    <h3>{craft.craftName}</h3>
                    <p>{craft.craftCode} · 版本 {craft.version}</p>
                  </div>
                  <StatusBadge tone={craft.active ? "success" : "warning"}>{craft.active ? "启用" : "停用"}</StatusBadge>
                  <div className="master-data-actions">
                    <Button disabled={Boolean(busy)} onClick={() => void reviseCraft(craft, "rename")}>修改名称</Button>
                    <Button disabled={Boolean(busy)} onClick={() => void reviseCraft(craft, "toggle")}>{craft.active ? "停用" : "恢复"}</Button>
                  </div>
                </article>
              ))}
            </div>
            <ListPagination page={craftPage.page} totalPages={craftPage.totalPages} onPageChange={craftPage.setPage} ariaLabel="外发工艺分页" />
          </Surface> : null}

          {view === "suppliers" ? <Surface className="master-data-panel">
            <div className="master-data-section-heading" id="factories">
              <h2>加工厂与供应商</h2>
              <div className="master-data-batch-actions">
                <Button disabled={Boolean(busy)} onClick={downloadSupplierTemplate}>下载导入模板</Button>
                <Button disabled={Boolean(busy)} onClick={exportSuppliers}>导出当前资料</Button>
                {canWriteSuppliers ? <label className="master-data-file-button">
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
                </label> : null}
              </div>
            </div>
            {canWriteSuppliers ? <div className="master-data-create">
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
              <Button data-ready={supplierName.trim() ? "true" : "false"} disabled={Boolean(busy)} onClick={() => void createSupplier()}>
                {busy === "create-supplier" ? "新增中…" : "新增"}
              </Button>
            </div> : null}
            <div className="master-data-list">
              {suppliers.length === 0 ? <p>暂无供应商。</p> : supplierPage.items.map((supplier) => (
                <article key={supplier.supplierId} className="master-data-row">
                  <div>
                    <h3>{supplier.supplierName}</h3>
                    <p>{supplier.supplierCode} · {supplierTypeLabels[supplier.supplierType]} · 版本 {supplier.version}</p>
                  </div>
                  <StatusBadge tone={supplier.active ? "success" : "warning"}>{supplier.active ? "启用" : "停用"}</StatusBadge>
                  {canWriteSuppliers ? <div className="master-data-actions">
                    <Button disabled={Boolean(busy)} onClick={() => void reviseSupplier(supplier, "rename")}>修改名称</Button>
                    <Button disabled={Boolean(busy)} onClick={() => void reviseSupplier(supplier, "toggle")}>{supplier.active ? "停用" : "恢复"}</Button>
                  </div> : null}
                </article>
              ))}
            </div>
            <ListPagination page={supplierPage.page} totalPages={supplierPage.totalPages} onPageChange={supplierPage.setPage} ariaLabel="供应商分页" />
          </Surface> : null}

          {view === "processes" ? <Surface className="master-data-panel">
            <div className="master-data-section-heading" id="processes">
              <h2>工序</h2>
              <div className="master-data-batch-actions">
                <Button disabled={Boolean(busy)} onClick={downloadProcessTemplate}>下载导入模板</Button>
                <Button disabled={Boolean(busy)} onClick={() => void exportProcesses()}>{busy === "export-processes" ? "导出中…" : "导出当前资料"}</Button>
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
            <form className="master-data-process-search" onSubmit={(event) => { event.preventDefault(); applyProcessSearch(); }}>
              <input
                type="search"
                value={processSearch}
                maxLength={100}
                placeholder="搜索工序名称或系统编码"
                aria-label="搜索工序"
                disabled={processPageLoading}
                onChange={(event) => setProcessSearch(event.target.value)}
              />
              <Button type="submit" disabled={Boolean(busy) || processPageLoading}>搜索</Button>
              {(processSearch || appliedProcessSearch) ? <Button type="button" disabled={Boolean(busy) || processPageLoading} onClick={clearProcessSearch}>清除</Button> : null}
            </form>
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
              <Button data-ready={processName.trim() ? "true" : "false"} disabled={Boolean(busy)} onClick={() => void createProcess()}>
                {busy === "create-process" ? "新增中…" : "新增"}
              </Button>
            </div>
            <div className="master-data-list">
              {processes.length === 0 ? <p>{appliedProcessSearch ? "没有匹配工序。" : "暂无公共工序。"}</p> : processes.map((process) => (
                <article key={process.processId} className="master-data-row">
                  <div>
                    <h3>{process.processName}</h3>
                    <p>{process.processCode} · {process.pricingUnit === "piece" ? "按件" : "按小时"} · 版本 {process.version} · 默认候选人 {formatBusinessDecimal(process.defaultWorkerPersonIds.length)} 人</p>
                  </div>
                  <StatusBadge tone={process.active ? "success" : "warning"}>{process.active ? "启用" : "停用"}</StatusBadge>
                  <div className="master-data-actions">
                    <Button disabled={Boolean(busy)} onClick={() => openProcessRoster(process)}>{editingProcessRosterId === process.processId ? "收起候选人" : "默认候选人"}</Button>
                    <Button disabled={Boolean(busy)} onClick={() => void reviseProcess(process, "rename")}>修改名称</Button>
                    <Button disabled={Boolean(busy)} onClick={() => void reviseProcess(process, "toggle")}>{process.active ? "停用" : "恢复"}</Button>
                  </div>
                  {editingProcessRosterId === process.processId ? <div className="master-data-process-roster">
                    <div className="master-data-process-roster__heading"><div><b>默认候选人</b><p>新订单选择该工序时自动带入，可在订单内调整。不会改动历史订单。</p></div><span>已选 {formatBusinessDecimal(processRosterDraft.length)} 人</span></div>
                    <input type="search" value={processRosterSearch} placeholder="搜索正式工或临时工" aria-label={`${process.processName} 默认候选人搜索`} onChange={(event) => setProcessRosterSearch(event.target.value)} />
                    <div className="master-data-process-roster__groups">{(["internal", "temporary"] as const).map((personType) => {
                      const query = processRosterSearch.trim().toLocaleLowerCase("zh-CN");
                      const candidates = processDefaultWorkerCandidates.filter((person) => person.personType === personType && (!query || `${person.displayName} ${person.temporaryRemark ?? ""}`.toLocaleLowerCase("zh-CN").includes(query)));
                      return <fieldset key={personType}><legend>{personType === "internal" ? "正式工" : "临时工"} · {formatBusinessDecimal(candidates.length)} 人</legend><div>{candidates.length ? candidates.map((person) => <label key={person.personId}><input type="checkbox" checked={processRosterDraft.includes(person.personId)} disabled={Boolean(busy)} onChange={(event) => toggleProcessRosterPerson(person.personId, event.target.checked)} /><span>{person.displayName}{person.temporaryRemark ? ` · ${person.temporaryRemark}` : ""}</span></label>) : <p>没有匹配人员</p>}</div></fieldset>;
                    })}</div>
                    <div className="master-data-actions"><Button disabled={Boolean(busy)} onClick={() => setEditingProcessRosterId("")}>取消</Button><Button variant="primary" disabled={Boolean(busy)} onClick={() => saveProcessRoster(process)}>{busy === `process-roster:${process.processId}` ? "保存中…" : "保存默认候选人"}</Button></div>
                  </div> : null}
                </article>
              ))}
            </div>
            <ListPagination
              page={processPage}
              totalPages={processTotalPages}
              busy={Boolean(busy) || processPageLoading}
              ariaLabel="公共工序分页"
              onPageChange={(nextPage) => { void showProcessPage(appliedProcessSearch, nextPage); }}
            />
          </Surface> : null}
        </div>

        {preview && previewSummary && (preview.kind !== "supplier" || canWriteSuppliers) ? (
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
                  <span>{row.message}{preview.kind === "supplier" ? ` · ${row.result?.message ?? (row.action === "skip" ? "无需执行" : row.action === "error" ? "预检错误" : "尚未执行")}` : ""}</span>
                </div>
              ))}
            </div>
            <label className="master-data-import-reason">
              操作原因
              <input disabled={Boolean(busy)} value={importReason} maxLength={500} onChange={(event) => setImportReason(event.target.value)} />
            </label>
            {!importReason.trim() && <p role="status">确认导入前请填写操作原因。</p>}
            {previewSummary.create + previewSummary.update === 0 && <p role="status">当前预检没有需要新增或更新的记录。</p>}
            <Button
              variant="primary"
              data-ready={previewSummary.error === 0 && Boolean(importReason.trim()) && previewSummary.create + previewSummary.update > 0 ? "true" : "false"}
              disabled={Boolean(busy) || (preview.kind === "supplier" && !canApplySupplierImport(preview.rows, importReason))}
              onClick={() => void applyImport()}
            >
              {busy === "batch-import" ? "导入中…" : preview.kind === "supplier" && preview.rows.some((row) => row.result) ? "继续未完成行" : "确认导入"}
            </Button>
          </Surface>
        ) : null}
      </div>
    </Shell>
  );
}
