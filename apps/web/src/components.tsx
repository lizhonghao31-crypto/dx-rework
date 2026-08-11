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
import "./shell-navigation.css";

const { apiUrl } = createWebUrls(import.meta.env.BASE_URL);

type ShellMe = Readonly<{
  status?: string;
  user?: AuthorizedUser;
}>;

type NavigationEntry = Readonly<{
  name: string;
  description: string;
  href: string;
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

function PrimaryNavigation({
  navigation,
  active,
  basePath,
}: {
  navigation: readonly NavigationEntry[];
  active: string;
  basePath: string;
}) {
  return (
    <nav className="primary-navigation" aria-label="主导航">
      {navigation.map((entry) => (
        <div className="primary-navigation__entry" key={entry.name}>
          <a href={`${basePath}${entry.href}`}>
            <NavigationItem icon="•" active={active === entry.name}>
              <span className="primary-navigation__copy">
                <strong>{entry.name}</strong>
                <small>{entry.description}</small>
              </span>
            </NavigationItem>
          </a>
        </div>
      ))}
    </nav>
  );
}

const MOBILE_PRIMARY_NAVIGATION_NAMES = ["我的待办", "发起返工", "全部订单"] as const;

const MOBILE_NAVIGATION_META: Record<string, Readonly<{ label: string; glyph: string }>> = {
  "我的待办": { label: "待办", glyph: "待" },
  "发起返工": { label: "发起", glyph: "发" },
  "全部订单": { label: "订单", glyph: "单" },
};

function isMobilePrimaryNavigation(entry: NavigationEntry): boolean {
  return MOBILE_PRIMARY_NAVIGATION_NAMES.includes(
    entry.name as (typeof MOBILE_PRIMARY_NAVIGATION_NAMES)[number],
  );
}

function MobileNavigationLink({
  entry,
  active,
  basePath,
}: {
  entry: NavigationEntry;
  active: string;
  basePath: string;
}) {
  const meta = MOBILE_NAVIGATION_META[entry.name] ?? { label: entry.name, glyph: "目" };
  const isActive = active === entry.name;
  return (
    <a href={basePath + entry.href} aria-current={isActive ? "page" : undefined}>
      <NavigationItem icon={meta.glyph} active={isActive}>
        <span className="mobile-primary-navigation__label">{meta.label}</span>
      </NavigationItem>
    </a>
  );
}

function MobilePrimaryNavigation({
  navigation,
  active,
  basePath,
}: {
  navigation: readonly NavigationEntry[];
  active: string;
  basePath: string;
}) {
  const primaryNavigation = navigation.filter(isMobilePrimaryNavigation);
  const moreNavigation = navigation.filter((entry) => !isMobilePrimaryNavigation(entry));
  const moreIsActive = moreNavigation.some((entry) => entry.name === active);

  return (
    <nav className="mobile-primary-navigation" aria-label="移动端主导航">
      {primaryNavigation.map((entry) => (
        <div className="mobile-primary-navigation__entry" key={entry.name}>
          <MobileNavigationLink entry={entry} active={active} basePath={basePath} />
        </div>
      ))}
      {moreNavigation.length ? (
        <details className="mobile-primary-navigation__more">
          <summary aria-label="更多导航">
            <span className={"mobile-primary-navigation__more-trigger" + (moreIsActive ? " is-active" : "")}>
              <b aria-hidden="true">更</b>
              <strong>更多</strong>
            </span>
          </summary>
          <div className="mobile-primary-navigation__drawer">
            <PrimaryNavigation navigation={moreNavigation} active={active} basePath={basePath} />
          </div>
        </details>
      ) : null}
    </nav>
  );
}

export function Shell({
  active,
  children,
  mobileNavigation = "primary",
}: {
  active: string;
  children: ReactNode;
  mobileNavigation?: "primary" | "transaction";
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
  const hasRole = (role: string) => currentUser?.businessRoles?.includes(role) === true;
  const hasCapability = (capability: string) => currentUser?.capabilities.includes(capability) === true;
  const initiationAccess = isRoot || isOwner || hasRole("quality_control") || hasCapability("rework:initiate");
  const auditAccess = isRoot || isOwner || (isSystemAdmin && hasCapability("audit:read"));
  const technicalAdminAccess = isRoot || (isSystemAdmin && hasCapability("admin:read"));
  const todoAccess = hasCapability("todo:view");
  const reportAccess = isRoot || isOwner || hasCapability("report:view");
  const wageAccess = isRoot || isOwner || hasCapability("wage:view");
  const systemManagementAccess = auditAccess || technicalAdminAccess || canManageEmployeeAccess
    || isRoot || isOwner || hasCapability("master_data:manage");

  const navigation: NavigationEntry[] = [];
  if (todoAccess) {
    navigation.push({
      name: "我的待办",
      description: "只看现在轮到你处理的事项",
      href: "/ui/my-tasks",
    });
  }
  if (initiationAccess) {
    navigation.push({
      name: "发起返工",
      description: "登记款号、问题、数量和证据",
      href: "/ui/qc/new",
    });
  }
  if (reportAccess) {
    navigation.push({
      name: "全部订单",
      description: "查看权限范围内订单及完整流程",
      href: "/ui/tasks",
    });
  }
  if (systemManagementAccess) {
    navigation.push({
      name: "系统管理",
      description: "权限、人员、资料与审计配置",
      href: "/ui/admin",
    });
  }
  if (reportAccess) navigation.push({
    name: "财务报表",
    description: "查询返工、责任、工资与扣款报表",
    href: "/ui/reports",
  });
  if (wageAccess) navigation.push({
    name: "工资管理",
    description: "核对工资、调整、月结和导出",
    href: "/ui/wages",
  });

  const roleLabels = currentUser
    ? [
        ...(isRoot ? ["超级用户"] : []),
        ...(currentUser.businessRoles?.map(roleLabel) ?? []),
      ]
    : [];
  const roleText = roleLabels.length ? roleLabels.join(" · ") : "未分配角色";
  const activeEntry = navigation.find((entry) => entry.name === active);

  return (
    <div className="app-shell">
      <aside>
        <h2>达兴 · 质检返工</h2>
        <PrimaryNavigation navigation={navigation} active={active} basePath={basePath} />
        <div className="org app-shell__identity">
          {currentUser ? (
            <div className="current-user">
              <b>{currentUser.displayName}</b>
              <small>{roleText}</small>
            </div>
          ) : null}
          <StatusBadge tone="success">组织内已认证</StatusBadge>
        </div>
      </aside>

      {mobileNavigation === "primary" ? (
        <MobilePrimaryNavigation navigation={navigation} active={activeEntry?.name ?? active} basePath={basePath} />
      ) : null}

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
  action?: string;
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
        {action ? (
          resolvedActionHref
            ? <a className="dx-button dx-button--secondary header-action-link" href={resolvedActionHref}>{action}</a>
            : <Button>{action}</Button>
        ) : null}
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
        "N05　返工执行中",
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
  const state = task.stateLabel ?? (
    task.tone === "danger"
      ? "已超时"
      : task.tone === "warning"
        ? "临近时限"
        : "待跟进"
  );
  return (
    <article className={`task task--${task.tone}`}>
      <b>{task.id}</b>
      <StatusBadge tone={task.tone}>{state}</StatusBadge>
      <h3>{task.title}</h3>
      <small>{task.meta}</small>
    </article>
  );
}
