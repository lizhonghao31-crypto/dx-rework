import { DigitalNotificationToast } from "./digital-notification-toast.js";
import { canAccessPatternRoom, canAccessPatternRoomPrices, canAccessPatternRoomOrders, canCreatePatternRoomOrders } from "./pattern-room-access.js";
import { financeNavigationEntries } from "./finance-access.js";
import { canAccessCutting } from "./cutting-access.js";
import { formatBusinessDecimal } from "@dx-rework/contracts/business-display";
import { TodoCountIndicatorSchema } from "@dx-rework/contracts";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Button,
  KpiInstrument,
  NavigationItem,
  StatusBadge,
  Surface,
} from "@dx-rework/ui";
import { createWebUrls } from "../url-contract.js";
import { hasPageAccess, verifySession, type AuthorizedUser } from "./auth.js";
import type { Task } from "./types.js";
import "./shell-navigation.css";
import "./production-command-center-view.css";
import "./digital-workspace.css";
import "./unified-shell.css";
import "@dx-rework/ui/production.css";
import { digitalWorkspaceActive } from "./digital-workspace-navigation.js";
import { cockpitReturnPath } from "./digital-journey-cockpit-model.js";
import { canAccessSupplierMaintenance } from "./supplier-onboarding-model.js";
import { canAccessDigitalProduction, canAccessSourcing, canAccessSupplierCenter, canAccessProduction, canAccessProductionReporting, canAccessSamples } from "./platform-modules.js";
import { installTodoIndicatorRefresh } from "./todo-indicator-refresh.js";
import { formatTodoBadgeCount } from "./todo-new-indicator.js";

import { NavigationIcon } from "./navigation-icons.js";

const { apiUrl } = createWebUrls(import.meta.env.BASE_URL);
const MOBILE_PULL_REFRESH_THRESHOLD = 56;
const MOBILE_PULL_REFRESH_MAX_DISTANCE = 72;

type NavigationEntry = Readonly<{
  name: string;
  description: string;
  href: string;
  activeKey?: string;
  label?: string;
  children?: readonly NavigationEntry[];
}>;

type NavigationGroup = Readonly<{
  name: string;
  description: string;
  entries: readonly NavigationEntry[];
}>;

const ROLE_LABELS: Record<string, string> = {
  cutting_supervisor: "裁床主管",
  cutting_worker: "裁床工人",
  pattern_room_supervisor: "板房主管",
  pattern_room_worker: "板房师傅",
  sample_designer: "样衣设计师",
  sample_administrative: "样衣管理员",
  sample_finance: "样衣财务",
  sample_approver: "样衣审批人",
  production_reporter: "驻厂生产填报",
  owner_group: "老板",
  system_admin: "系统管理员",
  production_management: "供应链总监",
  development_clerk: "开发文员",
  pattern_room_tail_inspector: "板房尾查",
  quality_control: "质检",
  warehouse_receiver: "仓管人员",
  tail_supervisor: "尾部主管",
  ie_reviewer: "IE 审核",
  order_merchandiser: "订单跟单",
  embroidery_washing_merchandiser: "印绣花/洗水跟单",
  factory_payables: "加工厂应付会计",
  embroidery_washing_payables: "印绣花洗水应付会计",
  fabric_payables: "面料供应商应付会计",
  administrative_clerk: "行政文员",
  wage_month_close_accountant: "工资资料查看",
  finance_read: "财务全局查看",
  finance_director: "财务总监",
  tail_inspector: "整查",
  worker: "员工",
};

const roleLabel = (role: string): string => ROLE_LABELS[role] ?? role;

function loadShellMe() {
  return verifySession().then((session) => session === "denied" ? null : session);
}

let employeeAccessPermission: Promise<boolean> | undefined;
function loadEmployeeAccessPermission(): Promise<boolean> {
  employeeAccessPermission ??= loadShellMe().then((body) => {
    if (body?.status !== "authorized" || !body.user) return false;
    return hasPageAccess(body.user, { requiredRole: "owner_group", requiredCapability: "access:admin" });
  });
  return employeeAccessPermission;
}

function TodoCountBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  const label = formatTodoBadgeCount(count);
  return (
    <span
      className="todo-count-badge"
      role="status"
      aria-label={`${formatBusinessDecimal(count)}项未完成待办`}
    >
      {label}
    </span>
  );
}

function PrimaryNavigation({
  navigation,
  active,
  basePath,
  pendingTodoCount = 0,
  iconSize = "secondary",
}: {
  navigation: readonly NavigationEntry[];
  active: string;
  basePath: string;
  pendingTodoCount?: number;
  iconSize?: "primary" | "secondary";
}) {
  return (
    <nav className="primary-navigation" aria-label="主导航">
      {navigation.map((entry) => (
        <div className="primary-navigation__entry" key={entry.name}>
          <a
            href={`${basePath}${entry.href}`}
            aria-current={active === (entry.activeKey ?? entry.name) ? "page" : undefined}
          >
            <NavigationItem icon={<NavigationIcon route={entry.href} size={iconSize} />} active={active === (entry.activeKey ?? entry.name)}>
              <span className="primary-navigation__copy">
                <strong>{entry.label ?? entry.name}</strong>
                <small title={entry.description}>{entry.description}</small>
                {entry.name === "我的待办"
                  ? <TodoCountBadge count={pendingTodoCount} />
                  : null}
              </span>
            </NavigationItem>
          </a>
          {entry.children?.length ? <div className="primary-navigation__children"><PrimaryNavigation navigation={entry.children} active={active} basePath={basePath} /></div> : null}
        </div>
      ))}
    </nav>
  );
}

export function NavigationGroupMenu({ group, active, basePath }: { group: NavigationGroup; active: string; basePath: string }) {
  if (!group.entries.length) return null;
  const groupIsActive = group.entries.some(entry => (entry.activeKey ?? entry.name) === active);
  return <details className={"desktop-navigation__group" + (groupIsActive ? " is-active" : "")} open={groupIsActive || undefined}>
    <summary><span><strong className="dx-navigation-group-label"><NavigationIcon group={group.name} size="primary" />{group.name}</strong><small>{group.description}</small></span><b aria-hidden="true">⌄</b></summary>
    <PrimaryNavigation navigation={group.entries} active={active} basePath={basePath} />
  </details>;
}

function DesktopNavigation({
  globalNavigation,
  groups,
  active,
  basePath,
  pendingTodoCount,
}: {
  globalNavigation: readonly NavigationEntry[];
  groups: readonly NavigationGroup[];
  active: string;
  basePath: string;
  pendingTodoCount: number;
}) {
  return (
    <nav className="desktop-navigation" aria-label="桌面端主导航">
      <div className="desktop-navigation__global">
        <PrimaryNavigation
          iconSize="primary"
          navigation={globalNavigation}
          active={active}
          basePath={basePath}
          pendingTodoCount={pendingTodoCount}
        />
      </div>
      {groups.map(group => <NavigationGroupMenu key={group.name} group={group} active={active} basePath={basePath} />)}
    </nav>
  );
}

const MOBILE_PRIMARY_NAVIGATION_NAMES = ["我的待办", "生产管理座舱", "订单回货", "返工单看板", "外发定价&选厂", "订单开裁", "供应商中心"] as const;

const MOBILE_NAVIGATION_META: Record<string, Readonly<{ label: string; glyph: string }>> = {
  "生产管理座舱": { label: "数字生产", glyph: "数" },
  "我的待办": { label: "待办", glyph: "待" },
  "订单回货": { label: "收货", glyph: "收" },
  "返工单看板": { label: "返工", glyph: "返" },
  "外发定价&选厂": { label: "外发", glyph: "发" },
  "订单开裁": { label: "开裁", glyph: "裁" },
  "供应商中心": { label: "供应商", glyph: "供" },
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
  pendingTodoCount,
}: {
  entry: NavigationEntry;
  active: string;
  basePath: string;
  pendingTodoCount: number;
}) {
  const meta = MOBILE_NAVIGATION_META[entry.name] ?? { label: entry.name, glyph: "目" };
  const isActive = active === (entry.activeKey ?? entry.name);
  return (
    <a
      href={basePath + entry.href}
      aria-current={isActive ? "page" : undefined}
    >
      <NavigationItem icon={<NavigationIcon route={entry.href} size="primary" />} active={isActive}>
        <span className="mobile-primary-navigation__label">{meta.label}</span>
        {entry.name === "我的待办"
          ? <TodoCountBadge count={pendingTodoCount} />
          : null}
      </NavigationItem>
    </a>
  );
}

function MobilePrimaryNavigation({
  navigation,
  financeGroup,
  active,
  basePath,
  pendingTodoCount,
}: {
  navigation: readonly NavigationEntry[];
  financeGroup: NavigationGroup;
  active: string;
  basePath: string;
  pendingTodoCount: number;
}) {
  const mobileCandidates = navigation.filter(isMobilePrimaryNavigation);
  const primaryNavigation = mobileCandidates.slice(0, 4);
  const moreNavigation = [
    ...mobileCandidates.slice(4),
    ...navigation.filter((entry) => !isMobilePrimaryNavigation(entry)),
    ...primaryNavigation.flatMap((entry) => entry.children ?? []),
  ];
  const moreIsActive = moreNavigation.some((entry) => (entry.activeKey ?? entry.name) === active) || financeGroup.entries.some(entry => entry.name === active);

  return (
    <nav className="mobile-primary-navigation" aria-label="移动端主导航">
      {primaryNavigation.map((entry) => (
        <div className="mobile-primary-navigation__entry" key={entry.name}>
          <MobileNavigationLink
            entry={entry}
            active={active}
            basePath={basePath}
            pendingTodoCount={pendingTodoCount}
          />
        </div>
      ))}
      {moreNavigation.length || financeGroup.entries.length ? (
        <details className="mobile-primary-navigation__more">
          <summary aria-label="更多导航">
            <span className={"mobile-primary-navigation__more-trigger" + (moreIsActive ? " is-active" : "")}>
              <b aria-hidden="true"><NavigationIcon group="更多" size="primary" /></b>
              <strong>更多</strong>
            </span>
          </summary>
          <div className="mobile-primary-navigation__drawer">
            <PrimaryNavigation navigation={moreNavigation} active={active} basePath={basePath} />
            <NavigationGroupMenu group={financeGroup} active={active} basePath={basePath} />
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
  appearance = "standard",
}: {
  active: string;
  children: ReactNode;
  mobileNavigation?: "primary" | "transaction";
  appearance?: "standard" | "digital";
}) {
  const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
  const [canManageEmployeeAccess, setCanManageEmployeeAccess] = useState(false);
  const [currentUser, setCurrentUser] = useState<AuthorizedUser | null>(null);
  const [pendingTodoCount, setPendingTodoCount] = useState(0);
  const [pullDistance, setPullDistance] = useState(0);
  const pullStartY = useRef<number | null>(null);
  const pullDistanceRef = useRef(0);

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

  useEffect(() => {
    if (!currentUser?.capabilities.includes("todo:view")) {
      setPendingTodoCount(0);
      return;
    }

    setPendingTodoCount(0);
    const controller = new AbortController();
    let checking = false;
    const checkIndicator = async () => {
      if (checking) return;
      checking = true;
      try {
        const response = await fetch(apiUrl("todos/mine/indicator"), {
          credentials: "include",
          headers: { accept: "application/json" },
          signal: controller.signal,
        });
        if (!response.ok) return;
        const responseActorId = response.headers.get("x-dx-rework-actor-id");
        if (responseActorId !== currentUser.id) {
          window.location.reload();
          return;
        }
        const indicator = TodoCountIndicatorSchema.parse(await response.json());
        setPendingTodoCount(indicator.pendingCount);
        window.dispatchEvent(new Event("dx-rework:todo-refresh"));
      } catch (error: unknown) {
        if (!controller.signal.aborted) console.warn("Todo indicator refresh failed", error);
      } finally {
        checking = false;
      }
    };
    const stopRefreshing = installTodoIndicatorRefresh(checkIndicator);
    return () => {
      controller.abort();
      stopRefreshing();
    };
  }, [currentUser]);

  useEffect(() => {
    const mobile = window.matchMedia("(max-width: 800px)");
    const resetPull = () => {
      pullStartY.current = null;
      pullDistanceRef.current = 0;
      setPullDistance(0);
    };
    const touchStart = (event: TouchEvent) => {
      if (!mobile.matches || window.scrollY > 0 || event.touches.length !== 1) return;
      pullStartY.current = event.touches[0]?.clientY ?? null;
    };
    const touchMove = (event: TouchEvent) => {
      if (pullStartY.current === null || window.scrollY > 0) {
        resetPull();
        return;
      }
      const currentY = event.touches[0]?.clientY;
      if (currentY === undefined) return;
      const distance = Math.min(
        MOBILE_PULL_REFRESH_MAX_DISTANCE,
        Math.max(0, (currentY - pullStartY.current) * 0.45),
      );
      pullDistanceRef.current = distance;
      setPullDistance(distance);
    };
    const touchEnd = () => {
      const shouldRefresh = pullDistanceRef.current >= MOBILE_PULL_REFRESH_THRESHOLD;
      resetPull();
      if (shouldRefresh) window.location.reload();
    };
    window.addEventListener("touchstart", touchStart, { passive: true });
    window.addEventListener("touchmove", touchMove, { passive: true });
    window.addEventListener("touchend", touchEnd, { passive: true });
    window.addEventListener("touchcancel", resetPull, { passive: true });
    return () => {
      window.removeEventListener("touchstart", touchStart);
      window.removeEventListener("touchmove", touchMove);
      window.removeEventListener("touchend", touchEnd);
      window.removeEventListener("touchcancel", resetPull);
    };
  }, []);

  const isRoot = currentUser?.isRoot === true;
  const isOwner = currentUser?.businessRoles?.includes("owner_group") === true;
  const isSystemAdmin = currentUser?.businessRoles?.includes("system_admin") === true;
  const hasRole = (role: string) => currentUser?.businessRoles?.includes(role) === true;
  const hasCapability = (capability: string) => currentUser?.capabilities.includes(capability) === true;
  const auditAccess = isRoot || (isSystemAdmin && hasCapability("audit:read"));
  const technicalAdminAccess = isRoot || (isSystemAdmin && hasCapability("admin:read"));
  const todoAccess = hasCapability("todo:view");
  const reportAccess = isRoot || isOwner || hasCapability("report:view");
  const reworkBoardAccess = reportAccess || hasCapability("dashboard:site:read")
    || hasCapability("rework:related_orders:view") || hasCapability("rework:basic:view") || hasCapability("rework:finance_orders:read");
  const financeNavigation = financeNavigationEntries(currentUser);
  const financeGroup: NavigationGroup = { name: "财务中心", description: "财务资料与工资", entries: financeNavigation };
  const systemManagementAccess = isRoot
    || auditAccess
    || technicalAdminAccess
    || (!isOwner && hasCapability("master_data:manage"));

  const globalNavigation: NavigationEntry[] = [];
  if (todoAccess) {
    globalNavigation.push({
      name: "我的待办",
      description: "查看所有模块当前轮到你的事项",
      href: "/ui/my-tasks",
    });
  }
  if (currentUser && canAccessDigitalProduction(currentUser)) globalNavigation.push(
    {name:"生产管理座舱",description:"查看数字开发与大货双进度",href:"/ui/digital-cockpit"},
  );
  if (currentUser && canAccessProduction(currentUser)) {
    globalNavigation.push({
      name: "实时生产看板",
      description: "查看生产订单与进度",
      href: "/ui/production-dashboard",
      ...(canAccessProductionReporting(currentUser) ? { children: [{ name: "生产数据填报", description: "按负责范围登记生产、完成与发货", href: "/ui/production-reporting" }] } : {}),
    });
  }
  globalNavigation.push({
    name: "订单回货",
    label: "订单回货看板",
    description: "查看每日收货与数量差异",
    href: "/ui/orders",
  });

  const reworkNavigation: NavigationEntry[] = [];
  if (reworkBoardAccess) {
    reworkNavigation.push({
      name: "返工单看板",
      description: "查看权限范围内返工单及完整流程",
      href: "/ui/tasks",
    });
  }
  if (reportAccess) reworkNavigation.push({
    name: "财务报表",
    description: "查询返工、责任、工资与扣款报表",
    href: "/ui/reports",
  });

  // Desktop-only sourcing navigation keeps the full create / pending / history workspace.
  const sourcingNavigation: NavigationEntry[] = [];
  if (currentUser && canAccessSourcing(currentUser)) {
    if (isRoot || (hasRole("order_merchandiser") && hasCapability("sourcing:inquiry:create"))) {
      sourcingNavigation.push({
        name: "创建订单",
        description: "跟单登记订单资料与照片",
        href: "/ui/sourcing/create",
      });
    }
    sourcingNavigation.push({
      name: "待审批订单",
      description: "查看未完成订单与完整审批流程",
      href: "/ui/sourcing/pending",
    });
    sourcingNavigation.push({
      name: "历史订单",
      description: "查询已完成订单与全量证据",
      href: "/ui/sourcing/history",
    });
  }

  const cuttingNavigation: NavigationEntry[] = currentUser && canAccessCutting(currentUser)
    ? [{ name: "裁床实裁", description: "登记士啤片与实裁数", href: "/ui/cutting", activeKey: "cutting" }]
    : [];

  const supplierNavigation: NavigationEntry[] = [];
  if (currentUser && canAccessSupplierCenter(currentUser)) {
    supplierNavigation.push({
      name: "供应商目录",
      description: "查询供应商资料、合同缺项与版本",
      href: "/ui/suppliers",
    });
    if (canAccessSupplierMaintenance(currentUser)) supplierNavigation.push({
      name: "资料维护",
      description: "在同一详情中维护资料与启停状态",
      href: "/ui/suppliers/manage",
    });
  }

  const patternRoomNavigation: NavigationEntry[] = currentUser && canAccessPatternRoom(currentUser) ? [
    ...(canAccessPatternRoomOrders(currentUser) ? [{ name: "订单打板/杂事看板", description: "查询打板与杂事订单", href: "/ui/pattern-room/orders", activeKey: "pattern-room-orders" }] : []),
    ...(canCreatePatternRoomOrders(currentUser) ? [{ name: "创建订单", description: "创建打板或杂事", href: "/ui/pattern-room/create", activeKey: "pattern-room-create" }] : []),
    ...(canAccessPatternRoomPrices(currentUser) ? [{ name: "价格管控", description: "品类单价与杂事小时单价", href: "/ui/pattern-room/prices" }] : []),
  ] : [];
  const sampleNavigation: NavigationEntry[] = currentUser && canAccessSamples(currentUser) ? [
    { name: "在管样衣", description: "借出、在库与保管资料", href: "/ui/samples" },
    { name: "待确认中心", description: "与你相关的借还和处置事项", href: "/ui/samples/pending" },
    { name: "已处置样衣", description: "出售、赠送、报废与遗失记录", href: "/ui/samples/disposed" },
  ] : [];
  if (sampleNavigation.length && (isRoot || ((hasRole("sample_finance") || hasRole("sample_approver") || hasRole("finance_director") || hasRole("finance_read") || isOwner) && hasCapability("sample:view_finance")))) {
    sampleNavigation.push({ name: "库存金额管理", description: "采购原值与处置回款", href: "/ui/samples/amounts" });
  }

  const platformNavigation: NavigationEntry[] = [];
  if (isRoot) platformNavigation.push({name:"合同模板设置",description:"维护合同文字与固定参数",href:"/ui/contract-template"});
  if (canManageEmployeeAccess) {
    platformNavigation.push({
      name: "人员与权限",
      description: "统一维护员工、角色与模块权限",
      href: "/ui/employee-access",
    });
  }
  if (systemManagementAccess) {
    platformNavigation.push({
      name: "系统管理",
      description: "维护基础资料、审计与技术配置",
      href: "/ui/admin",
    });
  }

  const mobileSourcingNavigation: NavigationEntry[] = currentUser && canAccessSourcing(currentUser)
    ? [{
        name: "外发定价&选厂",
        description: "查看外发定价、选厂和审批事项",
        href: "/ui/sourcing/pending",
      }]
    : [];
  const mobileSupplierNavigation: NavigationEntry[] = currentUser && canAccessSupplierCenter(currentUser)
    ? [{
        name: "供应商中心",
        description: "查看供应商资料、合同缺项和历史",
        href: "/ui/suppliers",
      }]
    : [];
  const productionNavigation: NavigationEntry[] = currentUser && canAccessProduction(currentUser)
    ? [
        { name: "实时看板", description: "查看生产双进度、交期与更新状态", href: "/ui/production-dashboard" },
        ...(canAccessProductionReporting(currentUser)
          ? [{ name: "生产数据填报", description: "按负责范围登记生产、完成与发货", href: "/ui/production-reporting" }]
          : []),
      ]
    : [];
  const digital = currentUser && canAccessDigitalProduction(currentUser);
  const designerNavigation: NavigationEntry[] = digital && (isRoot || (hasRole("sample_designer") && hasCapability("pattern_room:orders:create"))) ? [{ name: "设计师创建订单", description: "产品开发与订购资料", href: "/ui/digital-production?workspace=designer", activeKey: "digital-designer" }] : [];
  // Keep the mature creation capability, but place the source entry under creation.
  const creationNavigation = [...designerNavigation, ...patternRoomNavigation.filter(entry => entry.activeKey === "pattern-room-create")];
  const developmentNavigation: NavigationEntry[] = [
    ...(digital ? [{ name: "板房管理台", description: "开发任务与人员调度", href: "/ui/digital-cockpit?stage=development&workspace=pattern", activeKey: "digital-pattern" }] : []),
    ...patternRoomNavigation.filter(entry => entry.activeKey === "pattern-room-orders"),
    ...(digital ? [{ name: "板房数据沙盘", description: "同源分析与改进记录", href: "/ui/digital-analysis" }] : []),
    ...patternRoomNavigation.filter(entry => entry.href === "/ui/pattern-room/prices"),
  ];
  const preparationNavigation: NavigationEntry[] = digital ? [{ name: "大货产前准备", description: "产前订单与原单办理", href: "/ui/digital-cockpit?stage=bulk&workspace=preparation", activeKey: "digital-preparation" }] : [];
  const factoryNavigation: NavigationEntry[] = digital ? [{ name: "裁后工艺与发厂", description: "工艺、QC与实际发厂", href: "/ui/digital-cockpit?stage=bulk&workspace=factory", activeKey: "digital-factory" }] : [];
  const navigation: NavigationEntry[] = [
    ...creationNavigation,
    ...developmentNavigation.filter(entry => !patternRoomNavigation.includes(entry)),
    ...preparationNavigation,
    ...factoryNavigation,
    ...globalNavigation,
    ...reworkNavigation,
    ...mobileSourcingNavigation,
    ...(cuttingNavigation.length ? [{ name: "订单开裁", description: "裁床实裁登记", href: "/ui/cutting", activeKey: "cutting" }] : []),
    ...mobileSupplierNavigation,
    ...(patternRoomNavigation.length ? [{ name: "订单打板", description: "订单打板与价格管控", href: "/ui/pattern-room" }] : []),
    ...sampleNavigation,
    ...platformNavigation,
  ];
  const desktopNavigationGroups: NavigationGroup[] = [
    { name: "设计师创建订单", description: "产品开发源头", entries: creationNavigation },
    { name: "产品开发打板", description: "开发、打板与分析", entries: developmentNavigation },
    { name: "大货产前准备", description: "生产前置汇合", entries: preparationNavigation },
    { name: "外发定价&选厂", description: "询价、审批与执行", entries: sourcingNavigation },
    { name: "订单开裁", description: "裁床实裁", entries: cuttingNavigation },
    { name: "裁后工艺与发厂", description: "裁后办理", entries: factoryNavigation },
    {
      name: "订单返工",
      description: "订单返工业务",
      entries: reworkNavigation,
    },
    {
      name: "供应商中心",
      description: "供应商资料与维护",
      entries: supplierNavigation,
    },
    { name: "样衣管理", description: "样衣资料与实物保管", entries: sampleNavigation },
    financeGroup,
    {
      name: "平台管理",
      description: "人员、权限与系统配置",
      entries: platformNavigation,
    },
  ];

  const navigationActive = digitalWorkspaceActive(active, window.location.search);
  const roleLabels = currentUser?.businessRoles?.map(roleLabel) ?? [];
  const roleText = roleLabels.length ? roleLabels.join(" · ") : "已登录";
  const activeEntry = navigation.find((entry) => entry.name === active);
  const mobileActive = navigationActive !== active ? navigationActive : patternRoomNavigation.some(entry => entry.activeKey !== "pattern-room-create" && (entry.activeKey ?? entry.name) === active) ? "订单打板" : productionNavigation.some(entry => entry.name !== "生产数据填报" && entry.name === active) ? "实时生产看板" : cuttingNavigation.some((entry) => (entry.activeKey ?? entry.name) === active) ? "订单开裁" : sourcingNavigation.some((entry) => entry.name === active)
    ? "外发定价&选厂"
    : supplierNavigation.some((entry) => entry.name === active)
      ? "供应商中心"
      : activeEntry?.name ?? active;

  return (
    <div className={`app-shell ui-polish unified-shell${appearance === "digital" ? " digital-workspace production-command-shell" : ""}`}>
      {pullDistance > 0 ? (
        <div
          className="mobile-pull-refresh"
          style={{ transform: `translate(-50%, ${pullDistance}px)` }}
          role="status"
        >
          {pullDistance >= MOBILE_PULL_REFRESH_THRESHOLD ? "松开刷新" : "下拉刷新"}
        </div>
      ) : null}
      <aside>
        <a className="production-command-brand" href={basePath+(todoAccess?"/ui/my-tasks":digital?"/ui/digital-cockpit":globalNavigation[0]?.href??"/ui/orders")}><strong>DX</strong><span>达兴服装<small>数字生产平台</small></span></a>
        <DesktopNavigation
          globalNavigation={globalNavigation}
          groups={desktopNavigationGroups}
          active={navigationActive}
          basePath={basePath}
          pendingTodoCount={pendingTodoCount}
        />
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
        <MobilePrimaryNavigation
          navigation={navigation}
          financeGroup={financeGroup}
          active={mobileActive}
          basePath={basePath}
          pendingTodoCount={pendingTodoCount}
        />
      ) : null}

      <main>{cockpitReturnPath(window.location.search) && <a className="dx-button dx-button--secondary journey-return-link" href={basePath+cockpitReturnPath(window.location.search)}>返回生产管理座舱</a>}{children}</main>
      {currentUser?.capabilities.includes("todo:view") && <DigitalNotificationToast key={currentUser.id} userId={currentUser.id} />}
    </div>
  );
}

export function Header({
  title,
  iconRoute,
  subtitle,
  badge,
  badgePlacement = "actions",
  action,
  actionHref,
  backHref,
}: {
  title: string;
  iconRoute?: string;
  subtitle?: string;
  badge: string;
  badgePlacement?: "actions" | "subtitle";
  action?: string;
  actionHref?: string;
  backHref?: string;
}) {
  const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
  const pathname = typeof window === "undefined" ? "" : window.location.pathname;
  const headingRoute = iconRoute ?? (basePath && pathname.startsWith(`${basePath}/`) ? pathname.slice(basePath.length) : pathname);
  const resolvedActionHref = actionHref?.startsWith("/") ? `${basePath}${actionHref}` : actionHref;
  return (
    <header className="page-heading">
      <div className="page-heading__copy">
        <h1>{backHref ? <a className="rework-detail-back" href={`${basePath}${backHref}`} aria-label="返回来源列表">← 返回</a> : null}<NavigationIcon route={headingRoute} group={badge} size="title" />{title}</h1>
        {subtitle ? <div className="page-heading__subtitle-row">
          <p className="page-heading__subtitle">{subtitle}</p>
          {badgePlacement === "subtitle" ? <StatusBadge tone="info">{badge}</StatusBadge> : null}
        </div> : null}
      </div>
      <div className="page-heading__actions header-actions">
        {badgePlacement === "actions" ? <StatusBadge tone="info">{badge}</StatusBadge> : null}
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
        "N02　工序与候选单价",
        "N04　返工执行报数",
        "N05　尾部最终数量确认",
        "N06　IE 最终数量复核",
        "N07　责任判定",
        "N08　老板确认签字",
      ]
    : [
        "N01　发起返工",
        "N03　IE 核价",
        "N05　工人完工上数",
        "N08　责任判定",
        "N09　老板确认签字",
        "N10　后续结算",
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
