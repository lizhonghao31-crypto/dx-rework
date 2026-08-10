import { StatusBadge, Surface } from "@dx-rework/ui";
import { useEffect, useState } from "react";

import { createWebUrls } from "../url-contract.js";
import { Foundation } from "./pages.js";
import {
  AuthGate,
  DeniedPage,
  LoginPage,
  QrLoginPage,
  QrRelayPage,
  type AuthorizedUser,
} from "./auth.js";
import { Shell } from "./components.js";
import { ReworkInitiationWorkbench } from "./rework-initiation-workbench.js";
import { ReworkDetailPage } from "./rework-detail-page.js";
import { ProcessConfigurationForm } from "./process-configuration-form.js";
import { ResponsibilityQueuePage } from "./responsibility-queue-page.js";
import { OwnFactoryApprovalQueuePage } from "./own-factory-approval-queue-page.js";
import { ExternalResponsibilityQueuePage } from "./external-responsibility-queue-page.js";
import { WorkReportingForm } from "./work-reporting-form.js";
import { WagePage } from "./wages/wage-page.js";
import { ManagementDashboardPage } from "./reporting/management-dashboard-page.js";
import { ReworkQueryPage } from "./reporting/rework-query-page.js";
import { ReportCenterPage } from "./reporting/report-center-page.js";
import { WorkflowQueuePage } from "./reporting/workflow-queue-page.js";
import { AdminConsolePage } from "./admin-console-page.js";
import { EmployeeAccessPage } from "./employee-access-page.js";
import { MasterDataPage } from "./master-data-page.js";
import { WorkforceMasterDataPage } from "./workforce-master-data-page.js";
import { landingTarget } from "./landing-target.js";
import { MyTodosPage } from "./my-todos-page.js";
import { ResponsibilityTaskPage } from "./responsibility-task-page.js";

const { apiUrl, pageUrl } = createWebUrls(import.meta.env.BASE_URL);

const PROCESS_QUEUE_STATUSES = [
  "pending_process_configuration",
  "pending_ie_review",
] as const;
const WORK_QUEUE_STATUSES = [
  "pending_task_assignment",
  "in_progress",
  "pending_order_review",
  "pending_quantity_adjustment_ie_review",
] as const;

type LandingMe = {
  status: "authorized" | "no_role";
  user: AuthorizedUser;
};

type InternalLocation = Readonly<{
  path: string;
  search: string;
  hash: string;
}>;

function readInternalLocation(basePath: string): InternalLocation {
  return {
    path: window.location.pathname.startsWith(basePath)
      ? window.location.pathname.slice(basePath.length) || "/"
      : window.location.pathname,
    search: window.location.search,
    hash: window.location.hash,
  };
}

function useInternalLocation(basePath: string): InternalLocation {
  const [location, setLocation] = useState(() => readInternalLocation(basePath));

  useEffect(() => {
    const sync = () => setLocation(readInternalLocation(basePath));
    const navigate = (event: MouseEvent) => {
      if (
        event.defaultPrevented
        || event.button !== 0
        || event.metaKey
        || event.ctrlKey
        || event.shiftKey
        || event.altKey
      ) return;

      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest("a");
      if (!(anchor instanceof HTMLAnchorElement)) return;
      if (anchor.target || anchor.hasAttribute("download")) return;

      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      const relativePath = basePath !== "" && url.pathname.startsWith(basePath)
        ? url.pathname.slice(basePath.length) || "/"
        : url.pathname;
      const isPageRoute = relativePath === "/"
        || relativePath.startsWith("/ui/")
        || relativePath.startsWith("/system/")
        || relativePath.startsWith("/auth/");
      if (!isPageRoute) return;

      event.preventDefault();
      window.history.pushState({}, "", `${url.pathname}${url.search}${url.hash}`);
      window.scrollTo({ top: 0, left: 0 });
      sync();
    };

    window.addEventListener("popstate", sync);
    document.addEventListener("click", navigate);
    return () => {
      window.removeEventListener("popstate", sync);
      document.removeEventListener("click", navigate);
    };
  }, [basePath]);

  return location;
}

function HomeLanding() {
  const [message, setMessage] = useState("正在进入业务工作台…");

  useEffect(() => {
    let mounted = true;
    void fetch(apiUrl("auth/me"), { credentials: "include", cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) {
          window.location.replace(pageUrl("auth/login"));
          return;
        }
        const body = await response.json() as LandingMe;
        if (body.status === "no_role") {
          if (mounted) setMessage("当前账号尚未分配业务角色，请联系管理员。");
          return;
        }

        const target = landingTarget(body.user);
        if (!target) {
          if (mounted) setMessage("当前角色暂时没有可进入的业务模块，请联系管理员核对岗位权限。");
          return;
        }
        window.location.replace(pageUrl(target));
      })
      .catch(() => {
        if (mounted) setMessage("工作台加载失败，请刷新页面重试。");
      });

    return () => {
      mounted = false;
    };
  }, []);

  return (
    <main className="auth-shell">
      <Surface className="auth-card">
        <StatusBadge tone="info">达兴组织准入</StatusBadge>
        <h1>正在进入业务工作台</h1>
        <p>{message}</p>
      </Surface>
    </main>
  );
}

export function App() {
  const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
  const { path, search } = useInternalLocation(basePath);
  const hasReworkContext = new URLSearchParams(search).has("rework");
  if (path === "/") return <HomeLanding />;
  if (path === "/auth/login") return <LoginPage />;
  if (path === "/auth/denied") return <DeniedPage />;
  if (path === "/auth/qr") return <QrLoginPage />;
  if (path === "/auth/qr/relay") return <QrRelayPage />;
  let page;
  if (path === "/ui/admin" || path === "/ui/audit") page = <Shell active="系统管理"><AdminConsolePage /></Shell>;
  else if (path === "/ui/employee-access") page = <EmployeeAccessPage />;
  else if (path === "/ui/master-data") page = <MasterDataPage />;
  else if (path === "/ui/people") page = <WorkforceMasterDataPage />;
  else if (path === "/ui/management") page = <ManagementDashboardPage mode="management" />;
  else if (path === "/ui/my-tasks") page = <MyTodosPage />;
  else if (path.startsWith("/ui/my-tasks/")) page = <ResponsibilityTaskPage />;
  else if (path === "/ui/supervisor") page = <ManagementDashboardPage mode="site" />;
  else if (path === "/ui/responsibility") page = <ResponsibilityQueuePage />;
  else if (path === "/ui/own-factory-approvals") page = <OwnFactoryApprovalQueuePage />;
  else if (path === "/ui/external-responsibilities") page = <ExternalResponsibilityQueuePage />;
  else if (path === "/ui/wages" || path.startsWith("/ui/wages/")) page = <Shell active="工资管理"><WagePage path={path} /></Shell>;
  else if (path === "/ui/tasks") page = <ReworkQueryPage />;
  else if (path === "/ui/reports") page = <ReportCenterPage />;
  else if (path.startsWith("/ui/tasks/")) page = <ReworkDetailPage />;
  else if (path === "/ui/qc/new") page = <Shell active="发起返工"><ReworkInitiationWorkbench /></Shell>;
  else if (path === "/ui/process-configuration") page = hasReworkContext
    ? <Shell active="全部订单"><ProcessConfigurationForm /></Shell>
    : <WorkflowQueuePage active="全部订单" title="工序配置与 IE 审核工作台" statuses={PROCESS_QUEUE_STATUSES} />;
  else if (path === "/ui/work-reporting" || path === "/ui/piecework/collective") page = hasReworkContext
    ? <Shell active="全部订单"><WorkReportingForm /></Shell>
    : <WorkflowQueuePage active="全部订单" title="分工、完成登记与整单审核工作台" statuses={WORK_QUEUE_STATUSES} />;
  else if (path === "/system/foundation") page = <Foundation />;
  else return <HomeLanding />;

  const owner = { requiredRole: "owner_group" } as const;

  if (path === "/ui/qc/new") {
    return <AuthGate requiredAnyOf={[
      owner,
      { requiredRole: "quality_control", requiredCapability: "rework:initiate" },
    ]}>{page}</AuthGate>;
  }
  if (path === "/ui/my-tasks" || path.startsWith("/ui/my-tasks/")) {
    return <AuthGate requiredCapability="todo:view">{page}</AuthGate>;
  }
  if (path === "/ui/master-data" || path === "/ui/people") {
    return <AuthGate requiredAnyOf={[
      owner,
      { requiredCapability: "master_data:manage" },
    ]}>{page}</AuthGate>;
  }
  if (path === "/ui/process-configuration") {
    return <AuthGate requiredAnyOf={[
      owner,
      { requiredRole: "tail_supervisor", requiredCapability: "process:configure" },
      { requiredRole: "ie_reviewer", requiredCapability: "process:review" },
    ]}>{page}</AuthGate>;
  }
  if (path === "/ui/work-reporting" || path === "/ui/piecework/collective") {
    return <AuthGate requiredAnyOf={[
      owner,
      { requiredRole: "tail_supervisor", requiredCapability: "work:assign" },
      { requiredRole: "tail_supervisor", requiredCapability: "submission:audit" },
      { requiredRole: "tail_supervisor", requiredCapability: "quantity:adjust" },
      { requiredRole: "worker", requiredCapability: "work:report" },
      { requiredCapability: "work:report_for_worker" },
      { requiredRole: "order_merchandiser", requiredCapability: "quantity:confirm" },
      { requiredRole: "ie_reviewer", requiredCapability: "process:review" },
    ]}>{page}</AuthGate>;
  }
  if (path === "/ui/responsibility") {
    return <AuthGate requiredAnyOf={[
      owner,
      { requiredCapability: "responsibility:determine" },
      { requiredCapability: "responsibility:takeover" },
      { requiredCapability: "responsibility:confirm_high_multiplier" },
    ]}>{page}</AuthGate>;
  }
  if (path === "/ui/own-factory-approvals") {
    return <AuthGate requiredAnyOf={[
      owner,
      { requiredCapability: "own_factory:view" },
    ]}>{page}</AuthGate>;
  }
  if (path === "/ui/external-responsibilities") {
    return <AuthGate requiredAnyOf={[
      owner,
      { requiredCapability: "external_responsibility:view" },
    ]}>{page}</AuthGate>;
  }
  if (path === "/ui/wages" || path.startsWith("/ui/wages/")) {
    return <AuthGate requiredAnyOf={[
      owner,
      { requiredCapability: "wage:view" },
    ]}>{page}</AuthGate>;
  }
  if (path === "/ui/admin") {
    return <AuthGate requiredAnyOf={[
      owner,
      { requiredRole: "system_admin", requiredCapability: "admin:read" },
    ]}>{page}</AuthGate>;
  }
  if (path === "/ui/audit") {
    return <AuthGate requiredAnyOf={[
      owner,
      { requiredRole: "system_admin", requiredCapability: "audit:read" },
    ]}>{page}</AuthGate>;
  }
  if (path === "/ui/employee-access") {
    return <AuthGate requiredAnyOf={[
      owner,
      { requiredRole: "owner_group", requiredCapability: "access:admin" },
    ]}>{page}</AuthGate>;
  }
  if (path === "/ui/management") {
    return <AuthGate requiredAnyOf={[
      owner,
      { requiredCapability: "dashboard:management:read" },
    ]}>{page}</AuthGate>;
  }
  if (path === "/ui/supervisor") {
    return <AuthGate requiredAnyOf={[
      owner,
      { requiredCapability: "dashboard:site:read" },
    ]}>{page}</AuthGate>;
  }
  if (path === "/ui/tasks") {
    return <AuthGate requiredAnyOf={[
      owner,
      { requiredCapability: "dashboard:management:read" },
      { requiredCapability: "dashboard:site:read" },
      { requiredCapability: "report:view" },
    ]}>{page}</AuthGate>;
  }
  if (path === "/ui/reports") {
    return <AuthGate requiredAnyOf={[
      owner,
      { requiredCapability: "report:view" },
    ]}>{page}</AuthGate>;
  }
  return <AuthGate>{page}</AuthGate>;
}
