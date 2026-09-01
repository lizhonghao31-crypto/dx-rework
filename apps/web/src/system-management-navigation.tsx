import { useEffect, useState } from "react";

import { createWebUrls } from "../url-contract.js";
import type { AuthorizedUser } from "./auth.js";

const { apiUrl, pageUrl } = createWebUrls(import.meta.env.BASE_URL);

export type SystemManagementTechnicalTab = "audit" | "attachments" | "delegations" | "exceptions";
export type SystemManagementSection = "employee-access" | "master-data" | "workforce" | SystemManagementTechnicalTab;

const technicalTabs: readonly [SystemManagementTechnicalTab, string][] = [
  ["audit", "审计日志"],
  ["attachments", "附件管理"],
  ["delegations", "代理授权"],
  ["exceptions", "系统异常"],
];

type Access = Readonly<{ employee: boolean; masterData: boolean; technical: boolean }>;

export function SystemManagementNavigation({
  active,
  onTechnicalTabChange,
}: {
  active: SystemManagementSection;
  onTechnicalTabChange?: (tab: SystemManagementTechnicalTab) => void;
}) {
  const [access, setAccess] = useState<Access | null>(null);
  useEffect(() => {
    let mounted = true;
    void fetch(apiUrl("auth/me"), { credentials: "include", cache: "no-store" })
      .then(async (response) => response.ok ? await response.json() as { status: string; user?: AuthorizedUser } : null)
      .then((body) => {
        if (!mounted) return;
        const user = body?.status === "authorized" ? body.user : undefined;
        setAccess({
          employee: user?.isRoot === true || user?.businessRoles?.includes("owner_group") === true || user?.capabilities.includes("access:admin") === true,
          masterData: user?.isRoot === true || user?.businessRoles?.includes("owner_group") === true || user?.capabilities.includes("master_data:manage") === true,
          technical: user?.isRoot === true || (user?.businessRoles?.includes("system_admin") === true && user.capabilities.includes("admin:read")),
        });
      })
      .catch(() => { if (mounted) setAccess({ employee: false, masterData: false, technical: false }); });
    return () => { mounted = false; };
  }, []);

  if (access === null) return <p className="admin-navigation-loading">正在加载管理权限…</p>;
  const visibleTabs = access.technical ? technicalTabs : [];
  return <nav className="admin-navigation" aria-label="系统管理模块">
    {access.employee ? <a className={active === "employee-access" ? "active" : ""} href={pageUrl("ui/employee-access")}>人员与权限</a> : null}
    {access.masterData ? <a className={active === "master-data" ? "active" : ""} href={pageUrl("ui/master-data")}>工厂、供应商与工艺数据库</a> : null}
    {access.masterData ? <a className={active === "workforce" ? "active" : ""} href={pageUrl("ui/people")}>作业人员与临时工</a> : null}
    {visibleTabs.map(([tab, label]) => onTechnicalTabChange ? (
      <button key={tab} className={active === tab ? "active" : ""} onClick={() => onTechnicalTabChange(tab)}>{label}</button>
    ) : (
      <a key={tab} className={active === tab ? "active" : ""} href={`${pageUrl("ui/admin")}?tab=${tab}`}>{label}</a>
    ))}
  </nav>;
}
