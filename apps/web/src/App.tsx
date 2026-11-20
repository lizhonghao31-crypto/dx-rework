import {ForegroundLoading,beginForegroundWait,useForegroundWait} from './foreground-loading.js';
import './foreground-loading.css';
import {lazyBusinessPage,preloadBusinessRoute} from './lazy-business-page.js';
import {auxiliaryCatalogRequirements} from "./auxiliary-catalog-access.js";
import { ProductionWorkspace } from "@dx-rework/ui/production";
import {deliveryReturnPath} from './delivery-calendar-model.js';
import { DevelopmentWorkspaceReturn } from "./development-workspace-return.js";
import { cuttingPageRequirements } from "./cutting-access.js";
import { patternRoomPriceRequirements, patternRoomOrderRequirements, patternRoomCreateRequirements } from "./pattern-room-access.js";
import { patternPagePath } from "./pattern-order-query.js";
import { financePageRequirements } from "./finance-access.js";
import { installInternalNavigation } from "./internal-navigation.js";
import {cachedVerifiedSession} from "./auth-session.js";
import { StatusBadge, Surface } from "@dx-rework/ui";
import { useEffect, useRef, useState, type ComponentProps } from "react";

import { createWebUrls } from "../url-contract.js";
import {
  AuthGate,
  canOpenAuthorizedPage,
  DeniedPage,
  LoginPage,
  QrLoginPage,
  QrRelayPage,
  verifySession,
  type AuthorizedUser,
  SessionBoundary,
} from "./auth.js";
import { Shell } from "./components.js";
import {
  accessiblePlatformModules,
  DIGITAL_PRODUCTION_ROLES,
  PLATFORM_MODULE_QUERY,
  platformLandingTarget,
  shouldRedirectLegacyLandingToPlatformHome,
} from "./platform-modules.js";

const PatternHistoryPage=lazyBusinessPage(()=>import('./pattern-history-page.js').then(module=>({default:module.PatternHistoryPage})));
const AuxiliaryCatalogPage=lazyBusinessPage(()=>import('./auxiliary-catalog-page.js').then(module=>({default:module.AuxiliaryCatalogPage})));
const CockpitProductionSettings=lazyBusinessPage(()=>import('./cockpit-production-settings.js').then(module=>({default:module.CockpitProductionSettings})));
const DigitalAnalysisPage=lazyBusinessPage(()=>import('./digital-analysis-page.js').then(module=>({default:module.DigitalAnalysisPage})));
const DigitalCockpitPage=lazyBusinessPage(()=>import('./digital-cockpit-page.js').then(module=>({default:module.DigitalCockpitPage})));
const DeliveryCalendarPage=lazyBusinessPage(()=>import('./delivery-calendar-page.js').then(module=>({default:module.DeliveryCalendarPage})));
const DigitalQuotationPage=lazyBusinessPage(()=>import('./digital-quotation-panel.js').then(module=>({default:module.DigitalQuotationPage})));
const DigitalProductionPage=lazyBusinessPage(()=>import('./digital-production-page.js').then(module=>({default:module.DigitalProductionPage})));
const DigitalDesignerWorkspace=lazyBusinessPage(()=>import('./digital-designer-workspace.js').then(module=>({default:module.DigitalDesignerWorkspace})));
const DigitalPatternWorkspace=lazyBusinessPage(()=>import('./digital-pattern-workspace.js').then(module=>({default:module.DigitalPatternWorkspace})));
const PatternOrderCreatePage=lazyBusinessPage(()=>import('./pattern-order-create-page.js').then(module=>({default:module.PatternOrderCreatePage})));
const CuttingDetailPage=lazyBusinessPage(()=>import('./cutting-page.js').then(module=>({default:module.CuttingDetailPage})));
const CuttingListPage=lazyBusinessPage(()=>import('./cutting-page.js').then(module=>({default:module.CuttingListPage})));
const SupplierOnboardingPage=lazyBusinessPage(()=>import('./supplier-onboarding-page.js').then(module=>({default:module.SupplierOnboardingPage})));
const PatternRoomOrdersPage=lazyBusinessPage(()=>import('./pattern-room-orders-page.js').then(module=>({default:module.PatternRoomOrdersPage})));
const PatternRoomOrderDetailPage=lazyBusinessPage(()=>import('./pattern-room-orders-page.js').then(module=>({default:module.PatternRoomOrderDetailPage})));
const PatternRoomPage=lazyBusinessPage(()=>import('./pattern-room-page.js').then(module=>({default:module.PatternRoomPage})));
const PatternRoomPricesPage=lazyBusinessPage(()=>import('./pattern-room-prices-page.js').then(module=>({default:module.PatternRoomPricesPage})));
const ProductionDashboardPage=lazyBusinessPage(()=>import('./production-dashboard-page.js').then(module=>({default:module.ProductionDashboardPage})));
const ProductionDisplayWorkspace=lazyBusinessPage(()=>import('./production-display-workspace.js').then(module=>({default:module.ProductionDisplayWorkspace})));
const DigitalProductionWorkspace=lazyBusinessPage(()=>import('./digital-production-workspaces.js').then(module=>({default:module.DigitalProductionWorkspace})));
const SampleWorkspacePage=lazyBusinessPage(()=>import('./sample-workspace-page.js').then(module=>({default:module.SampleWorkspacePage})));
const SampleHandoffPage=lazyBusinessPage(()=>import('./sample-workflow-page.js').then(module=>({default:module.SampleHandoffPage})));
const SampleCreatePage=lazyBusinessPage(()=>import('./sample-create-page.js').then(module=>({default:module.SampleCreatePage})));
const ProductionReportingPage=lazyBusinessPage(()=>import('./production-reporting-page.js').then(module=>({default:module.ProductionReportingPage})));
const Foundation=lazyBusinessPage(()=>import('./pages.js').then(module=>({default:module.Foundation})));
const ReworkInitiationV2Form=lazyBusinessPage(()=>import('./rework-v2-form.js').then(module=>({default:module.ReworkInitiationV2Form})));
const ReworkDetailPage=lazyBusinessPage(()=>import('./rework-detail-page.js').then(module=>({default:module.ReworkDetailPage})));
const ProcessConfigurationForm=lazyBusinessPage(()=>import('./process-configuration-form.js').then(module=>({default:module.ProcessConfigurationForm})));
const ResponsibilityQueuePage=lazyBusinessPage(()=>import('./responsibility-queue-page.js').then(module=>({default:module.ResponsibilityQueuePage})));
const OwnFactoryApprovalQueuePage=lazyBusinessPage(()=>import('./own-factory-approval-queue-page.js').then(module=>({default:module.OwnFactoryApprovalQueuePage})));
const ExternalResponsibilityQueuePage=lazyBusinessPage(()=>import('./external-responsibility-queue-page.js').then(module=>({default:module.ExternalResponsibilityQueuePage})));
const WorkReportingForm=lazyBusinessPage(()=>import('./work-reporting-form.js').then(module=>({default:module.WorkReportingForm})));
const WagePage=lazyBusinessPage(()=>import('./wages/wage-page.js').then(module=>({default:module.WagePage})));
const ManagementDashboardPage=lazyBusinessPage(()=>import('./reporting/management-dashboard-page.js').then(module=>({default:module.ManagementDashboardPage})));
const ReworkQueryPage=lazyBusinessPage(()=>import('./reporting/rework-query-page.js').then(module=>({default:module.ReworkQueryPage})));
const ReportCenterPage=lazyBusinessPage(()=>import('./reporting/report-center-page.js').then(module=>({default:module.ReportCenterPage})));
const WorkflowQueuePage=lazyBusinessPage(()=>import('./reporting/workflow-queue-page.js').then(module=>({default:module.WorkflowQueuePage})));
const AdminConsolePage=lazyBusinessPage(()=>import('./admin-console-page.js').then(module=>({default:module.AdminConsolePage})));
const ContractTemplateSettingsPage=lazyBusinessPage(()=>import('./contract-template-settings-page.js').then(module=>({default:module.ContractTemplateSettingsPage})));
const EmployeeAccessPage=lazyBusinessPage(()=>import('./employee-access-page.js').then(module=>({default:module.EmployeeAccessPage})));
const MasterDataPage=lazyBusinessPage(()=>import('./master-data-page.js').then(module=>({default:module.MasterDataPage})));
const SupplierDirectoryPage=lazyBusinessPage(()=>import('./supplier-center-page.js').then(module=>({default:module.SupplierDirectoryPage})));
const SupplierMaintenancePage=lazyBusinessPage(()=>import('./supplier-center-page.js').then(module=>({default:module.SupplierMaintenancePage})));
const WorkforceMasterDataPage=lazyBusinessPage(()=>import('./workforce-master-data-page.js').then(module=>({default:module.WorkforceMasterDataPage})));
const MyTodosPage=lazyBusinessPage(()=>import('./my-todos-page.js').then(module=>({default:module.MyTodosPage})));
const ResponsibilityTaskPage=lazyBusinessPage(()=>import('./responsibility-task-page.js').then(module=>({default:module.ResponsibilityTaskPage})));
const ReceivingPage=lazyBusinessPage(()=>import('./receiving-page.js').then(module=>({default:module.ReceivingPage})));
const OrderBoardPage=lazyBusinessPage(()=>import('./order-board-page.js').then(module=>({default:module.OrderBoardPage})));
const FrontlineLandingPage=lazyBusinessPage(()=>import('./frontline-landing-page.js').then(module=>({default:module.FrontlineLandingPage})));
const FrontlineTaskPage=lazyBusinessPage(()=>import('./frontline-task-page.js').then(module=>({default:module.FrontlineTaskPage})));
const SourcingWorkspacePage=lazyBusinessPage(()=>import('./sourcing-workspace-page.js').then(module=>({default:module.SourcingWorkspacePage})));

const { apiUrl, pageUrl } = createWebUrls(import.meta.env.BASE_URL);

const PROCESS_QUEUE_STATUSES = [
  "pending_process_configuration",
  "pending_ie_review",
] as const;
const WORK_QUEUE_STATUSES = [
  "pending_task_assignment",
  "in_progress",
  "pending_order_review",
  "pending_final_quantity_ie_review",
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

function readInternalLocation(basePath:string,location:Pick<Location,"pathname"|"search"|"hash">=window.location):InternalLocation{
  return {
    path:location.pathname.startsWith(basePath)?location.pathname.slice(basePath.length)||"/":location.pathname,
    search:location.search,
    hash:location.hash,
  };
}

function useInternalLocation(basePath: string): InternalLocation {
  const [location, setLocation] = useState(() => readInternalLocation(basePath));

  useEffect(() => installInternalNavigation(basePath, () => setLocation(readInternalLocation(basePath)), target => {
    const session = cachedVerifiedSession();
    if (!session || session === "denied" || session.status !== "authorized") return;
    const ready = preloadBusinessRoute(routeContent(readInternalLocation(basePath, target)), element =>
      element.type !== AuthGate || canOpenAuthorizedPage(session.user, element.props as ComponentProps<typeof AuthGate>));
    return ready ? { ready, finish: beginForegroundWait() } : undefined;
  }), [basePath]);

  return location;
}

const PLATFORM_MODULE_SESSION_KEY = "dx-rework:platform-module";

function readSelectedPlatformModule(): string | null {
  try {
    return window.sessionStorage.getItem(PLATFORM_MODULE_SESSION_KEY);
  } catch {
    return null;
  }
}

function rememberReworkModule(): void {
  try {
    window.sessionStorage.setItem(PLATFORM_MODULE_SESSION_KEY, "rework");
  } catch {
    // Session storage can be unavailable in restricted embedded browsers.
  }
}

function skipsInitialPlatformEntryCheck(path: string): boolean {
  return path === "/"
    || path === "/ui/home"
    || path.startsWith("/ui/sourcing")
    || path.startsWith("/ui/cutting")
    || path.startsWith("/ui/samples")
    || path.startsWith("/auth/");
}

function useInitialPlatformEntryCheck(path: string, search: string): boolean {
  const initialLocation = useRef({ path, search }).current;
  const [ready, setReady] = useState(() => skipsInitialPlatformEntryCheck(initialLocation.path));

  useEffect(() => {
    if (ready) return;

    let mounted = true;
    const query = new URLSearchParams(initialLocation.search);
    if (query.get(PLATFORM_MODULE_QUERY) === "rework") {
      rememberReworkModule();
      setReady(true);
      return;
    }

    void verifySession().then((session) => {
      if (!mounted) return;

      if (session !== "denied" && session.status === "authorized") {
        const selectedModule = readSelectedPlatformModule();
        if (shouldRedirectLegacyLandingToPlatformHome(
          session.user,
          initialLocation.path,
          initialLocation.search,
          selectedModule,
        )) {
          window.location.replace(pageUrl("ui/home"));
          return;
        }

        if (accessiblePlatformModules(session.user).length >= 2) rememberReworkModule();
      }

      setReady(true);
    });

    return () => {
      mounted = false;
    };
  }, [initialLocation, ready]);

  return ready;
}

function PlatformEntryChecking() {
  return (
    <main className="auth-shell">
      <Surface className="auth-card">
        <StatusBadge tone="info">达兴组织准入</StatusBadge>
        <h1>正在进入业务工作台</h1>
        <p>正在核对可访问的业务模块…</p>
      </Surface>
    </main>
  );
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

        const target = platformLandingTarget(body.user);
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

function ReceivingReworkEntryRedirect() {
  useEffect(() => {
    window.location.replace(pageUrl("ui/orders"));
  }, []);

  return (
    <main className="auth-shell">
      <Surface className="auth-card">
        <StatusBadge tone="info">订单回货</StatusBadge>
        <h1>请从收货订单发起返工</h1>
        <p>正在返回订单回货看板…</p>
      </Surface>
    </main>
  );
}

function LegacySupplierCenterRedirect() {
  useEffect(() => {
    window.location.replace(pageUrl("ui/suppliers"));
  }, []);
  return <Shell active="供应商目录"><Surface className="admin-card"><p>正在进入供应商中心…</p></Surface></Shell>;
}

export function App() { return <SessionBoundary><ForegroundLoading /><AppRoutes /></SessionBoundary>; }

function AppRoutes() {
  const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
  const navigation = useInternalLocation(basePath);
  const { path: requestedPath, search } = navigation;
  const path = patternPagePath(requestedPath, search);
  const platformEntryReady = useInitialPlatformEntryCheck(path, search);
  useForegroundWait(!platformEntryReady&&path.startsWith("/ui/")?`entry:${path}${search}`:undefined);
  if(!platformEntryReady)return <PlatformEntryChecking/>;
  return routeContent(navigation);
}

function routeContent(navigation:InternalLocation){
  const {path:requestedPath,search}=navigation;
  const path=patternPagePath(requestedPath,search);
  const hasReworkContext=new URLSearchParams(search).has("rework");
  const receivingEntryBatchId=new URLSearchParams(search).get("receivingBatchId")?.trim()??"";
  if (path === "/") return <HomeLanding />;
  if (path === "/auth/login") return <LoginPage />;
  if (path === "/auth/denied") return <DeniedPage />;
  if (path === "/auth/qr") return <QrLoginPage />;
  if (path === "/auth/qr/relay") return <QrRelayPage />;
  const sampleMatch = path.match(/^\/ui\/samples\/([0-9a-f-]{36})$/i);
  const sourcingOrderMatch = path.match(/^\/ui\/sourcing\/orders\/([0-9a-f-]{36})$/i);
  const cuttingOrderMatch = path.match(/^\/ui\/cutting\/orders\/([0-9a-f-]{36})$/i);
  let page;
  if (path === "/ui/digital-analysis") page = <Shell active="digital-analysis" appearance="digital"><ProductionWorkspace><DigitalAnalysisPage navigation={navigation} /></ProductionWorkspace></Shell>;
  else if (path === "/ui/digital-cockpit") page = <Shell active="生产管理座舱" appearance="digital"><ProductionWorkspace>{new URLSearchParams(search).get("workspace")==="delivery"?<DeliveryCalendarPage key={search}/>:new URLSearchParams(search).get("workspace")==="settings" ? <CockpitProductionSettings/> : ["pattern","preparation"].includes(new URLSearchParams(search).get("workspace")??"") ? <DigitalPatternWorkspace key={search}/> : ["factory"].includes(new URLSearchParams(search).get("workspace") ?? "") ? <DigitalProductionWorkspace key={search} kind={new URLSearchParams(search).get("workspace") === "factory" ? "factory" : "preparation"}/> : <DigitalCockpitPage key={search} deliveryReturn={deliveryReturnPath(new URLSearchParams(search).get('deliveryReturn'),import.meta.env.BASE_URL)??undefined} />}</ProductionWorkspace></Shell>;
  else if(path === "/ui/digital-quotation") page = <Shell active="客户报价协作" appearance="digital"><ProductionWorkspace><DigitalQuotationPage key={search}/></ProductionWorkspace></Shell>;
  else if (path === "/ui/digital-production") page = <Shell active="开发与大货办理" appearance="digital"><ProductionWorkspace>{new URLSearchParams(search).get("workspace") === "designer" ? <DigitalDesignerWorkspace key={search}/> : <><DevelopmentWorkspaceReturn/><DigitalProductionPage key={search} /></>}</ProductionWorkspace></Shell>;
  else if (path === "/ui/digital-pattern-room") page = <Shell active="digital-pattern" appearance="digital"><ProductionWorkspace><DigitalPatternWorkspace key={search}/></ProductionWorkspace></Shell>;
  else if (path === "/ui/home") page = <HomeLanding />;
  else if (path === "/ui/sourcing" || path === "/ui/sourcing/pending") page = <SourcingWorkspacePage view="pending" />;
  else if (path === "/ui/samples/handoff") page = <SampleHandoffPage />;
  else if (path === "/ui/samples") page = <SampleWorkspacePage />;
  else if (path === "/ui/samples/create") page = <SampleCreatePage />;
  else if (path === "/ui/samples/batch-create") page = <SampleCreatePage batch />;
  else if (path === "/ui/samples/pending") page = <SampleWorkspacePage mode="pending" />;
  else if (path === "/ui/samples/disposed") page = <SampleWorkspacePage mode="disposed" />;
  else if (path === "/ui/samples/amounts") page = <SampleWorkspacePage mode="amounts" />;
  else if (sampleMatch?.[1]) page = <SampleWorkspacePage mode="detail" sampleId={sampleMatch[1]} />;
  else if (path === "/ui/sourcing/create") page = <SourcingWorkspacePage view="create" />;
  else if (path === "/ui/sourcing/history") page = <SourcingWorkspacePage view="history" />;
  else if (sourcingOrderMatch?.[1]) page = <SourcingWorkspacePage view="detail" sourcingCaseId={sourcingOrderMatch[1]} />;
  else if (path === "/ui/cutting") page = <Shell active="cutting"><CuttingListPage /></Shell>;
  else if (cuttingOrderMatch?.[1]) page = <Shell active="cutting" mobileNavigation="transaction"><CuttingDetailPage key={path} cuttingOrderId={cuttingOrderMatch[1]} /></Shell>;
  else if (path === "/ui/admin" || path === "/ui/audit") {
    const requestedTab = new URLSearchParams(search).get("tab");
    const adminTab = requestedTab === "attachments" || requestedTab === "delegations" || requestedTab === "exceptions"
      ? requestedTab
      : "audit";
    page = <Shell active="系统管理"><AdminConsolePage initialTab={adminTab} /></Shell>;
  }
  else if (path === "/ui/employee-access") page = <EmployeeAccessPage />;
  else if (path === "/ui/contract-template") page = <Shell active="合同模板设置"><ContractTemplateSettingsPage /></Shell>;
  else if (path === "/ui/production-dashboard" || /^\/ui\/production-dashboard\/[0-9a-f-]+$/i.test(path)) page = path === "/ui/production-dashboard" && (new URLSearchParams(search).get("workspace") === "display" || new URLSearchParams(search).has("motherOrderId")) ? <ProductionDisplayWorkspace key={search}/> : <ProductionDashboardPage productionOrderId={path.split("/")[3]} />;
  else if (path === "/ui/production-reporting" || /^\/ui\/production-reporting\/[0-9a-f-]+$/i.test(path)) page = <ProductionReportingPage productionOrderId={path.split("/")[3]} />;
  else if (path === "/ui/suppliers/requests") page = <SupplierOnboardingPage key="requests" />;
  else if (/^\/ui\/suppliers\/requests\/(new|[0-9a-f-]{36})$/i.test(path)) page = <SupplierOnboardingPage key={path} requestId={path.split("/")[4]!} />;
  else if (path === "/ui/suppliers") page = <SupplierDirectoryPage />;
  else if (path === "/ui/suppliers/manage") page = <SupplierMaintenancePage />;
  else if (path === "/ui/auxiliary-catalog") page = <AuxiliaryCatalogPage />;
  else if (path === "/ui/master-data") {
    const parameters = new URLSearchParams(search);
    const masterDataView = parameters.get("view");
    page = masterDataView === "suppliers"
      ? parameters.get("tool") === "onboarding"
        ? <MasterDataPage view="suppliers" />
        : <LegacySupplierCenterRedirect />
      : <MasterDataPage view={masterDataView === "processes" ? "processes" : "crafts"} />;
  }
  else if (path === "/ui/people") page = <WorkforceMasterDataPage />;
  else if (path === "/ui/frontline") page = <FrontlineLandingPage />;
  else if (path === "/ui/frontline/tasks") page = <FrontlineTaskPage />;
  else if (path === "/ui/my-tasks") page = <MyTodosPage />;
  else if (path.startsWith("/ui/my-tasks/")) page = <ResponsibilityTaskPage />;
  else if (path === "/ui/receiving") page = <ReceivingPage />;
  else if (path === "/ui/orders") page = <Shell active="订单回货"><OrderBoardPage /></Shell>;
  else if (path === "/ui/supervisor") page = <ManagementDashboardPage mode="site" />;
  else if (path === "/ui/responsibility") page = <ResponsibilityQueuePage />;
  else if (path === "/ui/own-factory-approvals") page = <OwnFactoryApprovalQueuePage />;
  else if (path === "/ui/external-responsibilities") page = <ExternalResponsibilityQueuePage />;
  else if (path === "/ui/pattern-room") page = <Shell active="订单打板"><PatternRoomPage /></Shell>;
  else if (path === "/ui/pattern-room/history") page = <Shell active="pattern-room-history"><PatternHistoryPage /></Shell>;
  else if (path === "/ui/pattern-room/orders") page = <Shell active="pattern-room-orders"><PatternRoomOrdersPage /></Shell>;
  else if (path === "/ui/pattern-room/create") page = <Shell active="pattern-room-create"><PatternOrderCreatePage /></Shell>;
  else if (/^\/ui\/pattern-room\/orders\/[^/]+$/.test(path)) page = <Shell active="pattern-room-orders"><PatternRoomOrderDetailPage key={path} orderId={path.split("/").pop()!} /></Shell>;
  else if (path === "/ui/pattern-room/prices") page = <Shell active="价格管控"><PatternRoomPricesPage /></Shell>;
  else if (path === "/ui/finance" || path === "/ui/wages" || path.startsWith("/ui/wages/")) page = <Shell active="工资管理"><WagePage path={path} /></Shell>;
  else if (path === "/ui/tasks") page = <ReworkQueryPage />;
  else if (path === "/ui/reports") page = <ReportCenterPage />;
  else if (path.startsWith("/ui/tasks/")) page = <ReworkDetailPage />;
  else if (path === "/ui/qc/new") page = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(receivingEntryBatchId)
    ? <Shell active="订单回货" mobileNavigation="transaction"><ReworkInitiationV2Form /></Shell>
    : <ReceivingReworkEntryRedirect />;
  else if (path === "/ui/process-configuration") page = hasReworkContext
    ? <Shell active="返工单看板" mobileNavigation="transaction"><ProcessConfigurationForm /></Shell>
    : <WorkflowQueuePage active="返工单看板" title="工序配置与 IE 审核工作台" statuses={PROCESS_QUEUE_STATUSES} />;
  else if (path === "/ui/work-reporting" || path === "/ui/piecework/collective") page = hasReworkContext
    ? <Shell active="返工单看板" mobileNavigation="transaction"><WorkReportingForm /></Shell>
    : <WorkflowQueuePage active="返工单看板" title="分工、完成登记与整单审核工作台" statuses={WORK_QUEUE_STATUSES} />;
  else if (path === "/system/foundation") page = <Foundation />;
  else return <HomeLanding />;

  const owner = { requiredRole: "owner_group" } as const;

  if(path === "/ui/digital-quotation")return <AuthGate requiredAnyOf={["sample_designer","order_merchandiser","pattern_room_worker","ie_reviewer","embroidery_washing_merchandiser","production_management","pmc","owner_group"].map(requiredRole=>({requiredRole}))}>{page}</AuthGate>;
  if(path === "/ui/digital-pattern-room")return <AuthGate requiredAnyOf={[...DIGITAL_PRODUCTION_ROLES.map(requiredRole=>({requiredRole})),...patternRoomOrderRequirements,...patternRoomPriceRequirements,...patternRoomCreateRequirements]}>{page}</AuthGate>;
  if(path==='/ui/digital-analysis'&&new URLSearchParams(navigation.search).get('view')==='production')return <AuthGate requiredAnyOf={DIGITAL_PRODUCTION_ROLES.map(requiredRole=>({requiredRole,requiredCapability:'report:view'}))}>{page}</AuthGate>;
  if (path === "/ui/digital-production" || path === "/ui/digital-cockpit" || path === "/ui/digital-analysis" || path === "/ui/digital-pattern-room") return <AuthGate requiredAnyOf={DIGITAL_PRODUCTION_ROLES.map(requiredRole => ({ requiredRole }))}>{page}</AuthGate>;
  if (path === "/ui/home") return <AuthGate>{page}</AuthGate>;
  if (path.startsWith("/ui/samples")) {
    if (path === "/ui/samples/handoff") return <AuthGate requiredRole="sample_administrative" requiredCapability="sample:view_basic">{page}</AuthGate>;
    if (path === "/ui/samples/create" || path === "/ui/samples/batch-create") {
      return <AuthGate requiredRole="sample_finance" requiredCapability={path.endsWith("batch-create") ? "sample:batch_create" : "sample:create"}>{page}</AuthGate>;
    }
    const roles = path === "/ui/samples/amounts" ? ["sample_finance", "finance_director", "finance_read", "owner_group"]
      : ["sample_designer", "sample_administrative", "sample_finance", "finance_director", "finance_read", "owner_group"];
    return <AuthGate requiredAnyOf={roles.map(requiredRole => ({ requiredRole,
      requiredCapability: path === "/ui/samples/amounts" ? "sample:view_finance" : "sample:view_basic",
    }))}>{page}</AuthGate>;
  }
  if (path.startsWith("/ui/sourcing")) {
    return <AuthGate requiredAnyOf={[
      owner,
      { requiredCapability: "sourcing:view" },
    ]}>{page}</AuthGate>;
  }
  if (path === "/ui/cutting" || path.startsWith("/ui/cutting/")) {
    return <AuthGate requiredAnyOf={cuttingPageRequirements}>{page}</AuthGate>;
  }

  if (path === "/ui/frontline" || path === "/ui/frontline/tasks") {
    return <AuthGate requiredAnyOf={[
      { requiredRole: "warehouse_receiver", requiredCapability: "receiving:create" },
      { requiredRole: "warehouse_supervisor", requiredCapability: "receiving:create" },
      { requiredRole: "worker", requiredCapability: "work:report" },
      { requiredRole: "worker", requiredCapability: "tail_inspection:report" },
    ]}>{page}</AuthGate>;
  }
  if (path === "/ui/receiving") {
    return <AuthGate requiredAnyOf={[
      { requiredRole: "warehouse_receiver", requiredCapability: "receiving:create" },
      { requiredRole: "warehouse_supervisor", requiredCapability: "receiving:create" },
    ]}>{page}</AuthGate>;
  }
  if (path === "/ui/qc/new") {
    const finishing = new URLSearchParams(search).get("kind") === "inhouse_finishing";
    return <AuthGate requiredAnyOf={finishing ? [
      owner,
      { requiredRole: "tail_supervisor", requiredCapability: "process:configure" },
    ] : [
      owner,
      { requiredRole: "quality_control", requiredCapability: "rework:initiate" },
    ]}>{page}</AuthGate>;
  }
  if (path === "/ui/my-tasks" || path.startsWith("/ui/my-tasks/")) {
    return <AuthGate requiredCapability="todo:view">{page}</AuthGate>;
  }
  if (path.startsWith("/ui/production-dashboard")) {
    return <AuthGate requiredAnyOf={[
      { requiredRole: "production_reporter", requiredCapability: "production-reporting" },
      { requiredRole: "quality_control", requiredCapability: "qc-production-progress" },
      { requiredRole: "owner_group", requiredCapability: "sourcing:view" },
      { requiredRole: "production_management", requiredCapability: "sourcing:view" },
      { requiredRole: "pmc", requiredCapability: "sourcing:view" },
      { requiredRole: "order_merchandiser", requiredCapability: "sourcing:view" },
      { requiredRole: "finance_director", requiredCapability: "sourcing:view" },
      { requiredRole: "finance_read", requiredCapability: "sourcing:view" },
    ]}>{page}</AuthGate>;
  }
  if (path.startsWith("/ui/production-reporting")) {
    return <AuthGate requiredAnyOf={[
      { requiredRole: "production_reporter", requiredCapability: "production-reporting" },
      { requiredRole: "quality_control", requiredCapability: "qc-production-progress" },
      { requiredRole: "owner_group", requiredCapability: "sourcing:view" },
      { requiredRole: "production_management", requiredCapability: "sourcing:view" },
      { requiredRole: "pmc", requiredCapability: "sourcing:view" },
      { requiredRole: "order_merchandiser", requiredCapability: "sourcing:view" },
    ]}>{page}</AuthGate>;
  }
  if (path.startsWith("/ui/suppliers")) {
    return <AuthGate requiredCapability="supplier_profile:read">{page}</AuthGate>;
  }
  if (path === "/ui/auxiliary-catalog") return <AuthGate requiredAnyOf={auxiliaryCatalogRequirements}>{page}</AuthGate>;
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
      { requiredRole: "worker", requiredCapability: "tail_inspection:report" },
      { requiredCapability: "work:report_for_worker" },
      { requiredRole: "order_merchandiser", requiredCapability: "quantity:confirm" },
      { requiredRole: "ie_reviewer", requiredCapability: "process:review" },
    ]}>{page}</AuthGate>;
  }
  if (path === "/ui/responsibility") {
    return <AuthGate requiredAnyOf={[
      { requiredRole: "pmc", requiredCapability: "external_responsibility:view" },
      owner,
      { requiredCapability: "responsibility:determine" },
      { requiredCapability: "responsibility:takeover" },
      { requiredCapability: "responsibility:confirm_high_multiplier" },
      { requiredCapability: "responsibility:owner_sign" },
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
  if (path === "/ui/pattern-room" || path.startsWith("/ui/pattern-room/")) {
    return <AuthGate requiredAnyOf={path === "/ui/pattern-room/create" ? patternRoomCreateRequirements : path === "/ui/pattern-room/prices" ? patternRoomPriceRequirements : [...patternRoomPriceRequirements, ...patternRoomOrderRequirements]}>{page}</AuthGate>;
  }
  if (path === "/ui/finance" || path === "/ui/wages" || path.startsWith("/ui/wages/")) {
    return <AuthGate requiredAnyOf={financePageRequirements}>{page}</AuthGate>;
  }
  if (path === "/ui/admin") {
    return <AuthGate requiredRole="system_admin" requiredCapability="admin:read">{page}</AuthGate>;
  }
  if (path === "/ui/audit") {
    return <AuthGate requiredRole="system_admin" requiredCapability="audit:read">{page}</AuthGate>;
  }
  if (path === "/ui/employee-access") {
    return <AuthGate requiredRole="root_superuser" requiredCapability="access:admin">{page}</AuthGate>;
  }
  if (path === "/ui/contract-template") {
    return <AuthGate requiredRole="root_superuser">{page}</AuthGate>;
  }
  if (path === "/ui/supervisor") {
    return <AuthGate requiredAnyOf={[
      owner,
      { requiredCapability: "dashboard:site:read" },
    ]}>{page}</AuthGate>;
  }
  if (path === "/ui/tasks") {
    return <AuthGate requiredAnyOf={[
      { requiredCapability: "rework:basic:view" },
      { requiredCapability: "rework:finance_orders:read" },
      owner,
      { requiredCapability: "dashboard:management:read" },
      { requiredCapability: "dashboard:site:read" },
      { requiredCapability: "report:view" },
      { requiredCapability: "rework:related_orders:view" },
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
