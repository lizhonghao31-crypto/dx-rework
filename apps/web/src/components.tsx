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

type NavigationEntry = Readonly<{
  step: string;
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

function FlowNavigation({
  navigation,
  active,
  basePath,
}: {
  navigation: readonly NavigationEntry[];
  active: string;
  basePath: string;
}) {
  return (
    <nav className="flow-navigation" aria-label="主导航">
      {navigation.map((entry, index) => (
        <div className="flow-navigation__entry" key={entry.name}>
          <a href={`${basePath}${entry.href}`}>
            <NavigationItem icon={entry.step} active={active === entry.name}>
              <span className="flow-navigation__copy">
                <strong>{entry.name}</strong>
                <small>{entry.description}</small>
              </span>
            </NavigationItem>
          </a>
          {index < navigation.length - 1 ? <span className="flow-navigation__arrow" aria-hidden="true">↓</span> : null}
        </div>
      ))}
    </nav>
  );
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
  const hasRole = (role: string) => currentUser?.businessRoles?.includes(role) === true;
  const hasCapability = (capability: string) => currentUser?.capabilities.includes(capability) === true;
  const managementAccess = isRoot || isOwner || hasCapability("dashboard:management:read");
  const initiationAccess = isRoot || isOwner || hasRole("quality_control") || hasCapability("rework:initiate");
  const processAccess = isRoot || isOwner
    || (hasRole("tail_supervisor") && hasCapability("process:configure"))
    || (hasRole("ie_reviewer") && hasCapability("process:review"));
  const workAccess = isRoot || isOwner
    || (hasRole("tail_supervisor") && hasCapability("work:assign"))
    || (hasRole("worker") && hasCapability("work:report"))
    || hasCapability("work:report_for_worker");
  const wageAccess = isRoot || isOwner || hasCapability("wage:view");
  const masterDataAccess = isRoot || isOwner || hasCapability("master_data:manage");
  const auditAccess = isRoot || isOwner || (isSystemAdmin && hasCapability("audit:read"));
  const technicalAdminAccess = isRoot || (isSystemAdmin && hasCapability("admin:read"));

  const navigation: NavigationEntry[] = [];
  if (managementAccess) {
    navigation.push({
      step: "0",
      name: "总览",
      description: "看全局进度、待办和异常",
      href: "/ui/management",
    });
  }
  if (initiationAccess) {
    navigation.push({
      step: "1",
      name: "发起返工",
      description: "登记款号、问题、数量和证据",
      href: "/ui/qc/new",
    });
  }
  if (managementAccess) {
    navigation.push({
      step: "2",
      name: "返工任务",
      description: "查返工单状态并进入当前节点",
      href: "/ui/tasks",
    });
  }
  if (processAccess) {
    navigation.push({
      step: "3",
      name: "工序配置",
      description: "配工序单价并完成 IE 审核",
      href: "/ui/process-configuration",
    });
  }
  if (workAccess) {
    navigation.push({
      step: "4",
      name: "分工上数",
      description: "分配人员、上数并做整单审核",
      href: "/ui/work-reporting",
    });
  }
  if (managementAccess) {
    navigation.push(
      {
        step: "5",
        name: "责任处理",
        description: "判定责任、倍率和承担比例",
        href: "/ui/responsibility",
      },
      {
        step: "6",
        name: "本厂审批",
        description: "老板确认本厂承担金额",
        href: "/ui/own-factory-approvals",
      },
      {
        step: "7",
        name: "外部扣款",
        description: "外部签收、应付确认和实扣跟进",
        href: "/ui/external-responsibilities",
      },
    );
  }
  if (wageAccess) {
    navigation.push({
      step: "8",
      name: "工资核对",
      description: "返工工资初核、复核和月结",
      href: "/ui/wages",
    });
  }
  if (masterDataAccess) {
    navigation.push(
      {
        step: "9",
        name: "基础资料",
        description: "维护工厂、供应商和工序",
        href: "/ui/master-data",
      },
      {
        step: "10",
        name: "人员资料",
        description: "维护作业人员和临时工",
        href: "/ui/people",
      },
    );
  }
  if (canManageEmployeeAccess) {
    navigation.push({
      step: "11",
      name: "权限管理",
      description: "给在职员工分配业务角色",
      href: "/ui/employee-access",
    });
  }
  if (auditAccess || technicalAdminAccess) {
    navigation.push({
      step: "12",
      name: "系统管理",
      description: "审计、附件、代理和异常",
      href: "/ui/admin",
    });
  }

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
        <FlowNavigation navigation={navigation} active={active} basePath={basePath} />
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

      <details className="mobile-flow-navigation">
        <summary>
          <span>流程导航</span>
          <b>{activeEntry ? `${activeEntry.step}. ${activeEntry.name}` : active}</b>
        </summary>
        <FlowNavigation navigation={navigation} active={active} basePath={basePath} />
      </details>

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
