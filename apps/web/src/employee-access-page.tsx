import { useEffect, useMemo, useState } from "react";
import { Button, StatusBadge, Surface } from "@dx-rework/ui";
import type { EmployeeAccessDirectory, EmployeeAccessEmployee } from "@dx-rework/contracts";
import { createWebUrls } from "../url-contract.js";
import "./employee-access.css";

const { apiUrl } = createWebUrls(import.meta.env.BASE_URL);

type Role = Readonly<{
  roleCode: string;
  displayName: string;
  description: string;
  capabilities: string[];
}>;
type CurrentUser = Readonly<{ userId: string; displayName: string }>;

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

const employeeTone = (employee: EmployeeAccessEmployee): "success" | "warning" | "danger" =>
  !employee.active || !employee.employed ? "danger" : employee.enabled ? "success" : "warning";

const employeeStatus = (employee: EmployeeAccessEmployee): string => {
  if (!employee.employed) return "非在职";
  if (!employee.active) return "组织停用";
  return employee.enabled ? "系统启用" : "系统停用";
};

export function EmployeeAccessPage() {
  const [directory, setDirectory] = useState<EmployeeAccessDirectory | null>(null);
  const [roles, setRoles] = useState<Role[]>([]);
  const [me, setMe] = useState<CurrentUser | null>(null);
  const [reasonByUser, setReasonByUser] = useState<Record<string, string>>({});
  const [roleByUser, setRoleByUser] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const load = async () => {
    setError("");
    try {
      const [nextDirectory, nextRoles, currentUser] = await Promise.all([
        json<EmployeeAccessDirectory>("employee-access/employees"),
        json<Role[]>("access/roles"),
        json<CurrentUser>("access/me"),
      ]);
      setDirectory(nextDirectory);
      setRoles(nextRoles);
      setMe(currentUser);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "员工权限数据加载失败");
    }
  };

  useEffect(() => { void load(); }, []);

  const usableOwnerCount = useMemo(
    () => directory?.employees.filter((employee) =>
      employee.enabled
      && employee.active
      && employee.employed
      && employee.businessRoles.includes("owner_group")).length ?? 0,
    [directory],
  );

  const mutate = async (key: string, work: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(key);
    setError("");
    try {
      await work();
      await load();
    } catch (mutationError) {
      setError(mutationError instanceof Error ? mutationError.message : "操作失败");
    } finally {
      setBusy("");
    }
  };

  const reason = (userId: string) => reasonByUser[userId]?.trim() ?? "";
  const selectedRole = (userId: string) => roleByUser[userId] ?? roles[0]?.roleCode ?? "";

  const sync = () => void mutate("sync", () =>
    json("employee-access/directory/sync", { method: "POST" }));

  const grant = (employee: EmployeeAccessEmployee) => {
    const selected = selectedRole(employee.userId);
    const why = reason(employee.userId);
    if (!selected || !why) {
      setError("授予角色前必须选择角色并填写原因。");
      return;
    }
    void mutate(`grant:${employee.userId}`, () =>
      json(`employee-access/employees/${employee.userId}/roles`, {
        method: "POST",
        body: JSON.stringify({ roleCode: selected, reason: why }),
      }));
  };

  const revoke = (employee: EmployeeAccessEmployee, assignmentId: string, roleCode: string) => {
    const why = reason(employee.userId);
    if (!why) {
      setError("撤销角色前必须填写原因。");
      return;
    }
    if (!window.confirm(`确认撤销 ${employee.displayName} 的 ${roleCode}？`)) return;
    void mutate(`revoke:${assignmentId}`, () =>
      json(`employee-access/assignments/${assignmentId}`, {
        method: "DELETE",
        body: JSON.stringify({ reason: why }),
      }));
  };

  const changeAccess = (employee: EmployeeAccessEmployee, action: "disable" | "restore") => {
    const why = reason(employee.userId);
    if (!why) {
      setError(`${action === "disable" ? "停用" : "恢复"}访问前必须填写原因。`);
      return;
    }
    if (!window.confirm(`确认${action === "disable" ? "停用" : "恢复"} ${employee.displayName} 的系统访问？`)) return;
    void mutate(`${action}:${employee.userId}`, () =>
      json(`employee-access/employees/${employee.userId}/${action}`, {
        method: "POST",
        body: JSON.stringify({ reason: why }),
      }));
  };

  return (
    <main className="employee-access-shell">
      <Surface className="employee-access-card">
        <div className="employee-access-heading">
          <div>
            <p className="eyebrow">老板权限组 · 员工权限管理</p>
            <h1>员工身份与业务角色</h1>
            <p>钉钉企业身份决定准入，返工系统角色独立维护；所有授权、撤销和访问状态变化均写入审计。</p>
          </div>
          <div className="employee-access-sync">
            <span>最近通讯录同步：{directory?.lastDirectorySyncedAt ? new Date(directory.lastDirectorySyncedAt).toLocaleString("zh-CN") : "尚未同步"}</span>
            <Button disabled={Boolean(busy)} onClick={sync}>{busy === "sync" ? "同步中…" : "同步钉钉通讯录"}</Button>
          </div>
        </div>

        {error ? <p className="employee-access-error" role="alert">{error}</p> : null}
        {!directory ? <p>正在加载员工目录…</p> : (
          <section className="employee-access-grid" aria-label="员工权限目录">
            {directory.employees.map((employee) => {
              const why = reasonByUser[employee.userId] ?? "";
              const activeAssignments = employee.roleHistory.filter((history) => history.revokedAt === null);
              const isSelf = me?.userId === employee.userId;
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
                      <p className="employee-access-id">DingTalk userid：{employee.providerUserId}</p>
                    </div>
                    <StatusBadge tone={employeeTone(employee)}>{employeeStatus(employee)}</StatusBadge>
                  </header>

                  <dl className="employee-access-facts">
                    <div><dt>部门</dt><dd>{employee.departments.length ? employee.departments.join(" / ") : "未同步"}</dd></div>
                    <div><dt>组织状态</dt><dd>active={String(employee.active)} · employed={String(employee.employed)}</dd></div>
                    <div><dt>系统状态</dt><dd>enabled={String(employee.enabled)} · {employee.hasLoggedIn ? "曾登录" : "未登录"}</dd></div>
                    <div><dt>最近组织校验</dt><dd>{new Date(employee.lastVerifiedAt).toLocaleString("zh-CN")}</dd></div>
                    <div><dt>当前角色</dt><dd>{employee.businessRoles.length ? employee.businessRoles.join("、") : "未分配"}</dd></div>
                  </dl>

                  <label className="employee-access-reason">
                    操作原因
                    <input
                      value={why}
                      maxLength={500}
                      placeholder="必填；将进入审计记录"
                      onChange={(event) => setReasonByUser((current) => ({ ...current, [employee.userId]: event.target.value }))}
                    />
                  </label>

                  <div className="employee-access-actions">
                    <select
                      aria-label={`${employee.displayName} 授予角色`}
                      value={selectedRole(employee.userId)}
                      onChange={(event) => setRoleByUser((current) => ({ ...current, [employee.userId]: event.target.value }))}
                    >
                      {roles.map((role) => <option key={role.roleCode} value={role.roleCode}>{role.displayName} · {role.roleCode}</option>)}
                    </select>
                    <Button
                      disabled={Boolean(busy) || isSelf || !employee.active || !employee.employed || !employee.enabled}
                      onClick={() => grant(employee)}
                    >
                      授予角色
                    </Button>
                    {employee.enabled ? (
                      <Button
                        disabled={Boolean(busy) || wouldDisableLastOwner}
                        onClick={() => changeAccess(employee, "disable")}
                      >
                        停用访问
                      </Button>
                    ) : (
                      <Button
                        disabled={Boolean(busy) || !employee.active || !employee.employed}
                        onClick={() => changeAccess(employee, "restore")}
                      >
                        恢复访问
                      </Button>
                    )}
                  </div>

                  <details className="employee-access-history">
                    <summary>角色历史（{employee.roleHistory.length}）</summary>
                    {employee.roleHistory.length === 0 ? <p>暂无角色历史。</p> : employee.roleHistory.map((history) => (
                      <div className="employee-access-history-row" key={history.assignmentId}>
                        <div>
                          <b>{history.roleCode}</b>
                          <p>授予：{new Date(history.grantedAt).toLocaleString("zh-CN")} · {history.grantReason}</p>
                          {history.revokedAt ? <p>撤销：{new Date(history.revokedAt).toLocaleString("zh-CN")} · {history.revokeReason ?? "—"}</p> : <p>当前有效</p>}
                        </div>
                        {history.revokedAt === null ? (
                          <Button
                            disabled={Boolean(busy) || (history.roleCode === "owner_group" && wouldDisableLastOwner)}
                            onClick={() => revoke(employee, history.assignmentId, history.roleCode)}
                          >
                            撤销
                          </Button>
                        ) : null}
                      </div>
                    ))}
                  </details>

                  {isSelf ? <p className="employee-access-note">当前登录身份不能给自己授予新角色。</p> : null}
                  {wouldDisableLastOwner ? <p className="employee-access-note">最后一名有效老板不可撤销 owner_group 或停用访问。</p> : null}
                  {activeAssignments.length === 0 ? <p className="employee-access-note">该员工当前没有有效业务角色。</p> : null}
                </article>
              );
            })}
          </section>
        )}
      </Surface>
    </main>
  );
}
