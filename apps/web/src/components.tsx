import { useEffect, useState, type ReactNode } from "react";
import {
  Button,
  KpiInstrument,
  NavigationItem,
  StatusBadge,
  Surface,
} from "@dx-rework/ui";
import { createWebUrls } from "../url-contract.js";
import { hasPageAccess, type AuthorizedUser } from "./auth.js";
import type { Task } from "./types.js";

const { apiUrl } = createWebUrls(import.meta.env.BASE_URL);

type ShellMe = Readonly<{
  status?: string;
  user?: AuthorizedUser;
}>;

const ROLE_LABELS: Record<string, string> = {
  owner_group: "老板",
  system_admin: "系统管理员",
  production_management: "生产管理",
  quality_control: "质检",
  tail_supervisor: "尾部主管",
  ie_reviewer: "IE 审核",
  order_merchandiser: "订单跟单",
  embroidery_washing_merchandiser: "印绣花/洗水跟单",
  factory_payables: "加工厂应付会计",
  embroidery_washing_payables: "印绣花洗水应付会计",
  fabric_payables: "面料供应商应付会计",
  administrative_clerk: "行政文员",
  wage_month_close_accountant: "工资月结会计",
  finance_read: "财务全局查看",
  worker: "员工",
};

const roleLabel = (role: string): string => ROLE_LABELS[role] ?? role;

let shellMeRequest: Promise<ShellMe | null> | undefined;
function loadShellMe(): Promise<ShellMe | null> {
  shellMeRequest ??= fetch(apiUrl("auth/me"), { credentials: "include" })
    .then(async (response) => response.ok ? await response.json() as ShellMe : null)
    .catch(() => null);
  return shellMeRequest;
}

let employeeAccessPermission: Promise<boolean> | undefined;
function loadEmployeeAccessPermission(): Promise<boolean> {
  employeeAccessPermission ??= loadShellMe().then((body) => {
    if (body?.status !== "authorized" || !body.user) return false;
    return hasPageAccess(body.user, { requiredRole: "owner_group", requiredCapability: "access:admin" });
  });
  return employeeAccessPermission;
}

export function Shell({
  active,
  children,
}: {
  active: string;
  children: ReactNode;
}) {
  const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
  const [canManageEmployeeAccess, setCanManageEmployeeAccess] = useState(false);
  const [currentUser, setCurrentUser] = useState<AuthorizedUser | null>(null);

  useEffect(() => {
    let mounted = true;
    void Promise.all([loadShellMe(), loadEmployeeAccessPermission()]).then(([body, allowed]) => {
      if (!mounted) return;
      if (body?.status === "authorized" && body.user) setCurrentUser(body.user);
      setCanManageEmployeeAccess(allowed);
    });
    return () => {
      mounted = false;
    };
  }, []);

  const isRoot = currentUser?.isRoot === true;
  const isOwner = currentUser?.businessRoles?.includes("owner_group") === true;
  const isSystemAdmin = currentUser?.businessRoles?.includes("system_admin") === true;
  const hasCapability = (capability: string) => currentUser?.capabilities.includes(capability) === true;
  const managementAccess = isRoot || isOwner || hasCapability("dashboard:management:read");
  const initiationAccess = isRoot || isOwner
    || currentUser?.businessRoles?.includes("quality_control") === true
    || hasCapability("rework:initiate");
  const masterDataAccess = isRoot || isOwner || hasCapability("master_data:manage");

  const navigation: [string, string, string][] = [];
  if (managementAccess) {
    navigation.push(
      ["总", "总览", "/ui/management"],
      ["工", "返工任务", "/ui/tasks"],
    );
  }
  if (initiationAccess) navigation.push(["发", "发起返工", "/ui/qc/new"]);
  if (managementAccess) {
    navigation.push(
      ["责", "责任处理", "/ui/responsibility"],
      ["审", "本厂审批", "/ui/own-factory-approvals"],
      ["扣", "外部扣款", "/ui/external-responsibilities"],
      ["计", "集体计件", "/ui/piecework/collective"],
    );
  }
  if (masterDataAccess) navigation.push(["资", "基础资料", "/ui/master-data"]);
  if (canManageEmployeeAccess) navigation.push(["权", "权限管理", "/ui/employee-access"]);
  if (isRoot || (isSystemAdmin && hasCapability("admin:read"))) {
    navigation.push(["管", "系统管理", "/ui/admin"]);
  }

  const canReadAudit = isRoot || isOwner || (
    isSystemAdmin && currentUser?.capabilities.includes("audit:read") === true
  );
  const roleLabels = currentUser
    ? [
        ...(isRoot ? ["超级用户"] : []),
        ...(currentUser.businessRoles?.map(roleLabel) ?? []),
      ]
    : [];
  const roleText = roleLabels.length ? roleLabels.join(" · ") : "未分配角色";

  return (
    <div className="app-shell">
      <aside>
        <h2>达兴 · 质检返工</h2>
        <nav aria-label="主导航">
          {navigation.map(([icon, name, href]) => (
            <a href={`${basePath}${href}`} key={name}>
              <NavigationItem icon={icon!} active={active === name}>
                {name}
              </NavigationItem>
            </a>
          ))}
          {canReadAudit ? (
            <a href={`${basePath}/ui/audit`}>
              <NavigationItem icon="审" active={active === "审计日志"}>审计日志</NavigationItem>
            </a>
          ) : null}
        </nav>
        <div className="org">
          {currentUser ? (
            <div className="current-user">
              <b>{currentUser.displayName}</b>
              <small>{roleText}</small>
            </div>
          ) : null}
          <StatusBadge tone="success">组织内已认证</StatusBadge>
        </div>
      </aside>
      <main>{children}</main>
    </div>
  );
}

export function Header({
  title,
  subtitle,
  badge,
  action,
  actionHref,
}: {
  title: string;
  subtitle?: string;
  badge: string;
  action: string;
  actionHref?: string;
}) {
  const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
  const resolvedActionHref = actionHref?.startsWith("/") ? `${basePath}${actionHref}` : actionHref;
  return (
    <header>
      <div>
        <h1>{title}</h1>
        {subtitle ? <p>{subtitle}</p> : null}
      </div>
      <div className="header-actions">
        <StatusBadge tone="info">{badge}</StatusBadge>
        {resolvedActionHref ? <a href={resolvedActionHref}><Button>{action}</Button></a> : <Button>{action}</Button>}
      </div>
    </header>
  );
}

export function Kpis({ supervisor = false }: { supervisor?: boolean }) {
  const data: [string, number, string][] = supervisor
    ? [
        ["待配置工序 / 单价", 4, "最早进入 09:18"],
        ["待分派 / 改成员", 3, "2 条待生成新快照"],
        ["待整单审核", 5, "含 1 条驳回重提"],
        ["现场异常", 2, "1 单等待补料"],
      ]
    : [
        ["待处理项", 12, "其中 3 单临近时限"],
        ["进行中", 8, "覆盖 4 个工序"],
        ["已超时", 3, "最长超时 1.6 天"],
        ["待责任确认", 5, "2 单待老板终审"],
      ];
  return (
    <div className="kpis">
      {data.map(([label, value, detail], index) => (
        <KpiInstrument
          key={label}
          label={label}
          value={value}
          detail={detail}
          tone={index === 2 ? "warning" : "info"}
        />
      ))}
    </div>
  );
}

export function Queue({ supervisor = false }: { supervisor?: boolean }) {
  const rows = supervisor
    ? [
        "N02　待配置工序 / 单价",
        "N04　待分派成员",
        "N04-V2　新成员快照待确认",
        "N06　待整单审核",
        "N10-A　工资初核",
        "异常　现场异常 / 等待补料",
      ]
    : [
        "N01　待主管配置",
        "N03　待 IE 复核",
        "N05　返工上数中",
        "N07　待责任确认",
        "N08-A　本厂承担审批",
        "N08-B　外部签收 / 扣款跟进",
      ];
  return (
    <Surface>
      <div className="section-title">
        <div>
          <h2>{supervisor ? "今日行动队列" : "全流程节点监控"}</h2>
        </div>
        {!supervisor && <StatusBadge tone="info">更新 14:32</StatusBadge>}
      </div>
      <div className="queue">
        {rows.map((row, index) => (
          <div key={row}>
            <span>{row}</span>
            <StatusBadge tone={index === 3 || index === 4 ? "warning" : "info"}>
              {index + 2} 单
            </StatusBadge>
          </div>
        ))}
      </div>
    </Surface>
  );
}

export function TaskCard({ task }: { task: Task }) {
  const state =
    task.tone === "danger"
      ? "已超时"
      : task.tone === "warning"
        ? "临近时限"
        : "待跟进";
  return (
    <article className={`task task--${task.tone}`}>
      <b>{task.id}</b>
      <StatusBadge tone={task.tone}>{state}</StatusBadge>
      <h3>{task.title}</h3>
      <small>{task.meta}</small>
    </article>
  );
}
