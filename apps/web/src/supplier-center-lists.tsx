import { Button, StatusBadge } from "@dx-rework/ui";
import { SUPPLIER_TYPE_LABELS, type SupplierSummary } from "./supplier-center-model.js";

type ListProps = {
  suppliers: readonly SupplierSummary[];
  disabled: boolean;
  onSelect: (id: string) => void;
};

function SupplierName({ supplier }: { supplier: SupplierSummary }) {
  return <><strong>{supplier.supplierName}</strong><small>{supplier.supplierCode}</small></>;
}

function SupplierStatus({ supplier }: { supplier: SupplierSummary }) {
  return <><StatusBadge tone={supplier.active ? "success" : "warning"}>{supplier.active ? "启用" : "停用"}</StatusBadge>
    {supplier.contractDataMissing.length
      ? <small>{supplier.contractDataMissing.length} 项合同资料缺失</small>
      : <small className="is-complete">合同资料完整</small>}</>;
}

export function SupplierDirectoryList({ suppliers, disabled, onSelect }: ListProps) {
  return <table className="supplier-records supplier-records--directory" aria-label="供应商目录">
    <thead><tr><th scope="col">供应商 / 编码</th><th scope="col">工艺与常规产能</th><th scope="col">状态 / 资料完整度</th><th scope="col">查看</th></tr></thead>
    <tbody>{suppliers.map(supplier => <tr key={supplier.supplierId}>
      <td><SupplierName supplier={supplier} /><small>{SUPPLIER_TYPE_LABELS[supplier.supplierType]}</small></td>
      <td data-label="工艺与常规产能"><span>{supplier.supportedCrafts.join("、") || "工艺尚未维护"}</span><small>{supplier.dailyCapacity === null ? "产能尚未维护" : `${supplier.dailyCapacity.toLocaleString("zh-CN")} 件 / 日`}</small></td>
      <td data-label="资料状态"><SupplierStatus supplier={supplier} /></td>
      <td className="supplier-records__action"><Button disabled={disabled} aria-label={`查看 ${supplier.supplierName}`} onClick={() => onSelect(supplier.supplierId)}>查看</Button></td>
    </tr>)}</tbody>
  </table>;
}

export function SupplierMaintenanceList({ suppliers, disabled, onSelect, canWrite }: ListProps & { canWrite: boolean }) {
  return <table className="supplier-records supplier-records--manage" aria-label="供应商资料维护">
    <thead><tr><th scope="col">供应商</th><th scope="col">类型</th><th scope="col">资料状态</th><th scope="col">最近修改</th><th scope="col">操作</th></tr></thead>
    <tbody>{suppliers.map(supplier => <tr key={supplier.supplierId}>
      <td><SupplierName supplier={supplier} /></td>
      <td data-label="类型">{SUPPLIER_TYPE_LABELS[supplier.supplierType]}</td>
      <td data-label="资料状态"><SupplierStatus supplier={supplier} /></td>
      <td data-label="最近修改">{supplier.changedAt ? <time dateTime={supplier.changedAt}>{new Date(supplier.changedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}</time> : "—"}</td>
      <td className="supplier-records__action"><Button disabled={disabled} aria-label={`${canWrite ? "维护" : "查看"} ${supplier.supplierName}`} onClick={() => onSelect(supplier.supplierId)}>{canWrite ? "维护资料" : "查看"}</Button></td>
    </tr>)}</tbody>
  </table>;
}
