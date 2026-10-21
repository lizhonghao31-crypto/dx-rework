import {z} from 'zod';
import {feedbackFetch,feedbackJson,feedbackNoContent,unknownWriteResult} from './request-response-feedback.js';
import {useDigitalDetailNavigationGuard} from './use-digital-detail-navigation-guard.js';
import {EmployeeAccessDirectorySchema,EmployeeAccessSyncResponseSchema,EmployeeAccessRoleMutationResponseSchema} from '@dx-rework/contracts/employee-access';
import { SearchableSelect } from "./search-select.js";
import { NavigationIcon } from "./navigation-icons.js";
import { formatBusinessDecimal } from "@dx-rework/contracts/business-display";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button, StatusBadge, Surface } from "@dx-rework/ui";
import type { EmployeeAccessDirectory, EmployeeAccessEmployee } from "@dx-rework/contracts/employee-access";
import { createWebUrls } from "../url-contract.js";
import { Shell } from "./components.js";
import { ListPagination, usePaginatedItems } from "./list-pagination.js";
import {
  employeesInAccessFilter,
  hasEffectiveRoleAccess,
  type EmployeeAccessFilter,
} from "./employee-access-filter.js";
import {
  accessModuleLabelsForRole,
  employeeHasAccessModule,
  type PlatformAccessModuleId,
} from "./platform-access.js";
import { SystemManagementNavigation } from "./system-management-navigation.js";
import { confirmInApp, promptInApp } from "./system-dialog.js";
import "./employee-access.css";

const { apiUrl } = createWebUrls(import.meta.env.BASE_URL);

const PROTECTED_ROLES = new Set(["owner_group", "system_admin"]);
const BUILTIN_ROLE_NAMES: Record<string, string> = {
  owner_group: "老板",
  system_admin: "系统管理员",
};

type Role = Readonly<{
  roleCode: string;
  displayName: string;
  description: string;
  capabilities: string[];
}>;
type CurrentUser = Readonly<{ userId: string; displayName: string; isRoot: boolean }>;

async function json<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method=init.method??'GET',response=await feedbackFetch(apiUrl(path), {
    credentials: "include",...init,headers:{accept:"application/json",...(init.body?{"content-type":"application/json"}:{}),...init.headers},
  });
  if(method==='DELETE'||/\/(?:disable|restore)$/.test(path)){await feedbackNoContent(response,method);return undefined as T;}
  return feedbackJson(response,method,value=>{
    if(path==='employee-access/employees')return EmployeeAccessDirectorySchema.parse(value) as T;
    if(path==='access/roles')return z.array(z.object({roleCode:z.string(),displayName:z.string(),description:z.string(),capabilities:z.array(z.string())}).passthrough()).parse(value) as T;
    if(path==='access/me')return z.object({userId:z.string(),displayName:z.string(),isRoot:z.boolean()}).passthrough().parse(value) as T;
    if(path==='employee-access/directory/sync')return EmployeeAccessSyncResponseSchema.parse(value) as T;
    return EmployeeAccessRoleMutationResponseSchema.parse(value) as T;
  });
}

const employeeTone = (employee: EmployeeAccessEmployee): "success" | "warning" | "danger" =>
  !employee.active || !employee.employed ? "danger" : employee.enabled ? "success" : "warning";

const employeeStatus = (employee: EmployeeAccessEmployee): string => {
  if (!employee.employed) return "非在职";
  if (!employee.active) return "组织停用";
  if (employee.enabled) return "系统启用";
  return employee.manualAccessDisabled ? "人工停用" : "未授权";
};

export function EmployeeAccessPage() {
  const [directory, setDirectory] = useState<EmployeeAccessDirectory | null>(null);
  const [roles, setRoles] = useState<Role[]>([]);
  const [me, setMe] = useState<CurrentUser | null>(null);
  const [reasonByUser, setReasonByUser] = useState<Record<string, string>>({});
  const [roleByUser, setRoleByUser] = useState<Record<string, string>>({});
  const [query, setQuery] = useState("");
  const [accessFilter, setAccessFilter] = useState<EmployeeAccessFilter>("all");
  const [moduleFilter, setModuleFilter] = useState<"all" | PlatformAccessModuleId>("all");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [reading,setReading]=useState(false),[uncertain,setUncertain]=useState(false),[refreshPending,setRefreshPending]=useState(false),[notice,setNotice]=useState("");
  const working=useRef(false),readVersion=useRef(0);useDigitalDetailNavigationGuard(uncertain,Boolean(busy),working,"原权限操作结果尚未确认，离开不会撤销操作；请先核对原员工记录。仍要离开？");
  const locked=Boolean(busy)||uncertain||refreshPending;
  const load = async (saved=false) => {
    const version=++readVersion.current;setReading(true);
    setError("");
    try {
      const [nextDirectory, nextRoles, currentUser] = await Promise.all([
        json<EmployeeAccessDirectory>("employee-access/employees"),
        json<Role[]>("access/roles"),
        json<CurrentUser>("access/me"),
      ]);
      if(version!==readVersion.current)return;
      setDirectory(nextDirectory);
      setRoles(nextRoles);
      setMe(currentUser);if(saved||refreshPending)setNotice("修改已保存，最新员工目录已重新读取。");setRefreshPending(false);
    } catch (loadError) {
      if(version===readVersion.current)setError((saved?"修改已保存，最新员工权限资料尚未读取；只需重读，不重复提交。":"")+(loadError instanceof Error ? loadError.message : "员工权限资料尚未读取"));
    }finally{if(version===readVersion.current)setReading(false);}
  };

  useEffect(() => { void load();return()=>{readVersion.current++;}; }, []);

  const roleNameByCode = useMemo(
    () => new Map(roles.map((role) => [role.roleCode, role.displayName])),
    [roles],
  );
  const roleName = (roleCode: string) => roleNameByCode.get(roleCode) ?? BUILTIN_ROLE_NAMES[roleCode] ?? roleCode;
  const roleByCode = useMemo(
    () => new Map(roles.map((role) => [role.roleCode, role])),
    [roles],
  );
  const roleDisplayName = (role: Role): string => {
    const modules = accessModuleLabelsForRole(role.roleCode, role.capabilities);
    return modules.length ? `${role.displayName}（${modules.join(" / ")}）` : role.displayName;
  };
  const assignedRoleDisplayName = (roleCode: string): string => {
    const role = roleByCode.get(roleCode);
    if (role) return roleDisplayName(role);
    const modules = accessModuleLabelsForRole(roleCode);
    return modules.length
      ? `${roleName(roleCode)}（${modules.join(" / ")}）`
      : roleName(roleCode);
  };

  const usableOwnerCount = useMemo(
    () => directory?.employees.filter((employee) =>
      employee.enabled
      && employee.active
      && employee.employed
      && employee.businessRoles.includes("owner_group")).length ?? 0,
    [directory],
  );

  const filteredEmployees = useMemo(() => {
    if (!directory) return [];
    const employees = employeesInAccessFilter(directory.employees, accessFilter)
      .filter((employee) => moduleFilter === "all"
        || employee.isRoot
        || employeeHasAccessModule(employee.businessRoles, roles, moduleFilter));
    const needle = query.trim().toLocaleLowerCase("zh-CN");
    if (!needle) return employees;
    return employees.filter((employee) => {
      const roleNames = employee.businessRoles.map((code) => roleNameByCode.get(code) ?? BUILTIN_ROLE_NAMES[code] ?? code);
      const haystack = [
        employee.displayName,
        employee.providerUserId,
        employee.departments.join(" "),
        employee.businessRoles.join(" "),
        roleNames.join(" "),
      ].join(" ").toLocaleLowerCase("zh-CN");
      return haystack.includes(needle);
    });
  }, [accessFilter, directory, moduleFilter, query, roleNameByCode, roles]);
  const employeePage = usePaginatedItems(
    filteredEmployees,
    `${accessFilter}:${moduleFilter}:${query}`,
  );

  const effectiveRoleCount = useMemo(
    () => directory?.employees.filter(hasEffectiveRoleAccess).length ?? 0,
    [directory],
  );

  const mutate = async (key: string, work: () => Promise<unknown>) => {
    if (busy||uncertain||refreshPending||working.current) return;
    working.current=true;
    setBusy(key);
    setError("");
    try {
      await work();setRefreshPending(true);setNotice("修改已保存；正在重新读取员工目录。");
      await load(true);
    } catch (mutationError) {
      const unknown=unknownWriteResult(mutationError);setUncertain(unknown);
      setError((unknown?"原权限操作结果尚未确认，请仅重新读取目录及原员工历史，不要重复发起或同步；仍不明确请Root核对审计。":"")+(mutationError instanceof Error ? mutationError.message : "操作结果尚未确认"));
    } finally {
      working.current=false;setBusy("");
    }
  };

  const reason = (userId: string) => reasonByUser[userId]?.trim() ?? "";
  const selectedRole = (userId: string, assignableRoles: Role[]) => {
    const selected = roleByUser[userId];
    return assignableRoles.some((role) => role.roleCode === selected)
      ? selected!
      : assignableRoles[0]?.roleCode ?? "";
  };

  const requireReason = async (employee: EmployeeAccessEmployee, action: string): Promise<string> => {
    const existing = reason(employee.userId);
    if (existing) return existing;
    const entered = (await promptInApp(`${action}前请输入操作原因`, ""))?.trim() ?? "";
    if (!entered) return "";
    setReasonByUser((current) => ({ ...current, [employee.userId]: entered }));
    return entered;
  };

  const sync = () => void mutate("sync", () =>
    json("employee-access/directory/sync", { method: "POST" }));

  const grant = async (employee: EmployeeAccessEmployee, selected: string): Promise<void> => {
    if (!selected) {
      setError("请先选择要授予的角色。");
      return;
    }
    const why = await requireReason(employee, "授予角色");
    if (!why) return;
    void mutate(`grant:${employee.userId}`, () =>
      json(`employee-access/employees/${employee.userId}/roles`, {
        method: "POST",
        body: JSON.stringify({ roleCode: selected, reason: why }),
      }));
  };

  const revoke = async (employee: EmployeeAccessEmployee, assignmentId: string, roleCode: string): Promise<void> => {
    const why = await requireReason(employee, "撤销角色");
    if (!why) return;
    if (!(await confirmInApp(`确认撤销 ${employee.displayName} 的 ${roleName(roleCode)}？`))) return;
    void mutate(`revoke:${assignmentId}`, () =>
      json(`employee-access/assignments/${assignmentId}`, {
        method: "DELETE",
        body: JSON.stringify({ reason: why }),
      }));
  };

  const changeAccess = async (employee: EmployeeAccessEmployee, action: "disable" | "restore"): Promise<void> => {
    const label = action === "disable" ? "停用访问" : "恢复访问";
    const why = await requireReason(employee, label);
    if (!why) return;
    if (!(await confirmInApp(`确认${action === "disable" ? "停用" : "恢复"} ${employee.displayName} 的系统访问？`))) return;
    void mutate(`${action}:${employee.userId}`, () =>
      json(`employee-access/employees/${employee.userId}/${action}`, {
        method: "POST",
        body: JSON.stringify({ reason: why }),
      }));
  };

  return (
    <Shell active="人员与权限">
      <div className="employee-access-shell">
        <header className="page-heading employee-access-heading">
          <div>
            <h1><NavigationIcon route="/ui/employee-access" size="title" />人员与权限</h1>
            <p>在同一个平台入口维护员工、业务角色及其模块权限。</p>
          </div>
          <div className="employee-access-sync">
            <span>最近同步：{directory?.lastDirectorySyncedAt ? new Date(directory.lastDirectorySyncedAt).toLocaleString("zh-CN") : "尚未同步"}</span>
            <Button disabled={locked} onClick={sync}>{busy === "sync" ? "同步中…" : "同步钉钉通讯录"}</Button>
          </div>
        </header>
        <Surface className="admin-card"><SystemManagementNavigation active="employee-access" /></Surface>
        <Surface className="employee-access-card">
          <div className="employee-access-toolbar">
            <select
              value={accessFilter}
              aria-label="员工范围"
              onChange={(event) => setAccessFilter(event.target.value as EmployeeAccessFilter)}
            >
              <option value="all">全部员工</option>
              <option value="effective-role">当前生效且已分配角色</option>
            </select>
            <select
              value={moduleFilter}
              aria-label="业务模块"
              onChange={(event) => setModuleFilter(event.target.value as "all" | PlatformAccessModuleId)}
            >
              <option value="all">全部模块</option>
              <option value="rework">订单返工</option>
              <option value="sourcing">外发定价&amp;选厂</option>
              <option value="cutting">订单开裁</option>
              <option value="suppliers">供应商中心</option>
              <option value="production">实时生产看板</option>
              <option value="samples">样衣管理</option>
                <option value="pattern_room">订单打板</option>
              <option value="platform">平台管理</option>
            </select>
            <input
              type="search"
              value={query}
              placeholder="搜索姓名、钉钉 UserID、部门或角色"
              aria-label="搜索员工"
              onChange={(event) => setQuery(event.target.value)}
            />
            <span>
              显示 {formatBusinessDecimal(filteredEmployees.length)} 人 · 当前生效且已分配角色 {formatBusinessDecimal(effectiveRoleCount)} 人
              {` · 全部 ${formatBusinessDecimal(directory?.employees.length ?? 0)} 人`}
            </span>
          </div>

          {notice&&<p role="status">{notice}</p>}{busy&&<p role="status">正在处理原操作，请等待结果。</p>}
          {error ? <p className="employee-access-error" role="alert">{error}</p> : null}
          {(error||uncertain)&&<><Button disabled={Boolean(busy)||reading} onClick={()=>void load()}>仅重新读取员工目录</Button>{uncertain&&<p role="status">重读目录只供核对，不等于收到原权限操作的回执；原操作仍待确认。</p>}</>}
          {!directory ? <p>{reading?"正在读取员工目录…":"员工目录尚未读取，请重试读取。"}</p> : filteredEmployees.length === 0 ? (
            <p className="employee-access-empty">没有匹配的员工。</p>
          ) : (<>
            <section className="employee-access-grid" aria-label="员工权限目录">
              {employeePage.items.map((employee) => {
                const why = reasonByUser[employee.userId] ?? "";
                const activeAssignments = employee.roleHistory.filter((history) => history.revokedAt === null);
                const assignableRoles = roles.filter((role) =>
                  !activeAssignments.some((history) => history.roleCode === role.roleCode));
                const selected = selectedRole(employee.userId, assignableRoles);
                const isSelf = me?.userId === employee.userId;
                const canSelfGrantSystemAdmin = isSelf
                  && me?.isRoot === true
                  && selected === "system_admin";
                const protectedTarget = employee.isRoot
                  || employee.businessRoles.some((role) => PROTECTED_ROLES.has(role));
                const assignedRoleNames = employee.businessRoles.map(assignedRoleDisplayName);
                const accessRoleNames = employee.isRoot
                  ? ["Root（订单返工 / 外发定价&选厂 / 订单开裁 / 供应商中心 / 实时生产看板 / 样衣管理 / 订单打板 / 平台管理）", ...assignedRoleNames]
                  : assignedRoleNames;
                const protectedTargetLocked = protectedTarget && me?.isRoot !== true;
                const wouldDisableLastOwner =
                  employee.businessRoles.includes("owner_group")
                  && employee.enabled
                  && employee.active
                  && employee.employed
                  && usableOwnerCount <= 1;

                return (
                  <article className="employee-access-employee" key={employee.userId}>
                    <header>
                      <div>
                        <h2>{employee.displayName}</h2>
                        <p className="employee-access-id">钉钉 UserID：{employee.providerUserId}</p>
                      </div>
                      <StatusBadge tone={employeeTone(employee)}>{employeeStatus(employee)}</StatusBadge>
                    </header>

                    <dl className="employee-access-facts">
                      <div><dt>部门</dt><dd>{employee.departments.length ? employee.departments.join(" / ") : "未同步"}</dd></div>
                      <div><dt>组织状态</dt><dd>{employee.employed && employee.active ? "正常在职" : employee.employed ? "组织停用" : "非在职"}</dd></div>
                      <div><dt>系统状态</dt><dd>{employeeStatus(employee)} · {employee.hasLoggedIn ? "已登录过" : "未登录"}</dd></div>
                      <div><dt>最近校验</dt><dd>{new Date(employee.lastVerifiedAt).toLocaleString("zh-CN")}</dd></div>
                      <div><dt>当前角色 / 模块</dt><dd>{accessRoleNames.length ? accessRoleNames.join("、") : "未分配"}</dd></div>
                    </dl>

                    <details className="employee-access-history">
                      <summary>角色历史（{formatBusinessDecimal(employee.roleHistory.length)}）</summary>
                      {employee.roleHistory.length === 0 ? <p>暂无角色历史。</p> : employee.roleHistory.map((history) => (
                        <div className="employee-access-history-row" key={history.assignmentId}>
                          <div>
                            <b>{roleName(history.roleCode)}</b>
                            <p>授予：{new Date(history.grantedAt).toLocaleString("zh-CN")} · {history.grantReason}</p>
                            {history.revokedAt ? <p>撤销：{new Date(history.revokedAt).toLocaleString("zh-CN")} · {history.revokeReason ?? "—"}</p> : <p>当前有效</p>}
                          </div>
                          {history.revokedAt === null ? (
                            <Button
                              disabled={locked
                                || (PROTECTED_ROLES.has(history.roleCode) && me?.isRoot !== true)
                                || (history.roleCode === "owner_group" && wouldDisableLastOwner)}
                              onClick={() => void revoke(employee, history.assignmentId, history.roleCode)}
                            >
                              撤销
                            </Button>
                          ) : null}
                        </div>
                      ))}
                    </details>

                    {isSelf ? (
                      <p className="employee-access-note">
                        当前账号仅允许唯一超级用户为自己授予系统管理员；其他自授角色仍禁止。
                      </p>
                    ) : null}
                    {protectedTargetLocked ? <p className="employee-access-note">Root、老板和系统管理员账号仅可由超级用户维护。</p> : null}
                    {wouldDisableLastOwner ? <p className="employee-access-note">最后一名有效老板不可撤销老板角色或停用访问。</p> : null}
                    {activeAssignments.length === 0 ? <p className="employee-access-note">当前没有业务角色。</p> : null}
                    {activeAssignments.length > 0 && assignableRoles.length === 0 ? <p className="employee-access-note">所有可授予角色均已生效。</p> : null}
                    <footer className="employee-access-footer">
                    <label className="employee-access-reason">
                      操作原因（必填）
                      <input
                        value={why}
                        maxLength={500}
                        placeholder="例如：岗位调整；留空点击操作时会提示填写"
                        onChange={(event) => setReasonByUser((current) => ({ ...current, [employee.userId]: event.target.value }))}
                      />
                    </label>

                    <div className="employee-access-actions">
                      <SearchableSelect
                        aria-label={`${employee.displayName} 授予角色`}
                        value={selected}
                        disabled={assignableRoles.length === 0}
                        onChange={(event) => setRoleByUser((current) => ({ ...current, [employee.userId]: event.target.value }))}
                      >
                        {assignableRoles.map((role) => <option key={role.roleCode} value={role.roleCode}>{roleDisplayName(role)}</option>)}
                      </SearchableSelect>
                      <Button
                        disabled={locked
                          || !selected
                          || (isSelf && !canSelfGrantSystemAdmin)
                          || !employee.active
                          || !employee.employed
                          || employee.manualAccessDisabled}
                        onClick={() => void grant(employee, selected)}
                      >
                        授予角色
                      </Button>
                      {employee.enabled ? (
                        <Button
                          disabled={locked || wouldDisableLastOwner || protectedTargetLocked}
                          onClick={() => void changeAccess(employee, "disable")}
                        >
                          停用访问
                        </Button>
                      ) : employee.manualAccessDisabled ? (
                        <Button
                          disabled={locked || !employee.active || !employee.employed || protectedTargetLocked}
                          onClick={() => void changeAccess(employee, "restore")}
                        >
                          恢复访问
                        </Button>
                      ) : null}
                    </div>
                    </footer>
                  </article>
                );
              })}
            </section>
            <ListPagination page={employeePage.page} totalPages={employeePage.totalPages} onPageChange={employeePage.setPage} ariaLabel="员工权限目录分页" />
          </>)}
        </Surface>
      </div>
    </Shell>
  );
}