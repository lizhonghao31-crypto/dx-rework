import { Detail, Foundation, MobileForm } from "./pages.js";
import { AuthGate, DeniedPage, LoginPage, QrLoginPage, QrRelayPage } from "./auth.js";
import { ReworkInitiationForm } from "./rework-form.js";
import { ProcessConfigurationForm } from "./process-configuration-form.js";
import { ResponsibilityQueuePage } from "./responsibility-queue-page.js";
import { OwnFactoryApprovalQueuePage } from "./own-factory-approval-queue-page.js";
import { ExternalResponsibilityQueuePage } from "./external-responsibility-queue-page.js";
import { WorkReportingForm } from "./work-reporting-form.js";
import { WagePage } from "./wages/wage-page.js";
import { ManagementDashboardPage } from "./reporting/management-dashboard-page.js";
import { ReworkQueryPage } from "./reporting/rework-query-page.js";
import { ReportCenterPage } from "./reporting/report-center-page.js";
import { AdminConsolePage } from "./admin-console-page.js";
import { EmployeeAccessPage } from "./employee-access-page.js";

export function App() {
  const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
  const path = window.location.pathname.startsWith(basePath)
    ? window.location.pathname.slice(basePath.length) || "/"
    : window.location.pathname;
  if (path === "/auth/login") return <LoginPage />;
  if (path === "/auth/denied") return <DeniedPage />;
  if (path === "/auth/qr") return <QrLoginPage />;
  if (path === "/auth/qr/relay") return <QrRelayPage />;
  let page;
  if (path === "/ui/admin") page = <AdminConsolePage />;
  else if (path === "/ui/employee-access") page = <EmployeeAccessPage />;
  else if (path === "/ui/management") page = <ManagementDashboardPage mode="management" />;
  else if (path === "/ui/supervisor") page = <ManagementDashboardPage mode="site" />;
  else if (path === "/ui/responsibility") page = <ResponsibilityQueuePage />;
  else if (path === "/ui/own-factory-approvals") page = <OwnFactoryApprovalQueuePage />;
  else if (path === "/ui/external-responsibilities") page = <ExternalResponsibilityQueuePage />;
  else if (path === "/ui/wages" || path.startsWith("/ui/wages/")) page = <WagePage path={path} />;
  else if (path === "/ui/tasks") page = <ReworkQueryPage />;
  else if (path === "/ui/reports") page = <ReportCenterPage />;
  else if (path.startsWith("/ui/tasks/")) page = <Detail />;
  else if (path === "/ui/qc/new") page = <ReworkInitiationForm />;
  else if (path === "/ui/process-configuration") page = <ProcessConfigurationForm />;
  else if (path === "/ui/work-reporting") page = <WorkReportingForm />;
  else if (path === "/ui/piecework/collective") page = <MobileForm piecework />;
  else if (path === "/system/foundation") page = <Foundation />;
  else page = <Foundation />;
  if (path === "/ui/qc/new") {
    return (
      <AuthGate requiredRole="quality_control" requiredCapability="rework:initiate">
        {page}
      </AuthGate>
    );
  }
  if (path === "/ui/process-configuration") {
    return (
      <AuthGate requiredAnyOf={[
        { requiredRole: "tail_supervisor", requiredCapability: "process:configure" },
        { requiredRole: "ie_reviewer", requiredCapability: "process:review" },
      ]}>
        {page}
      </AuthGate>
    );
  }
  if (path === "/ui/work-reporting") {
    return <AuthGate>{page}</AuthGate>;
  }
  if (path === "/ui/wages" || path.startsWith("/ui/wages/")) {
    return <AuthGate requiredCapability="wage:view">{page}</AuthGate>;
  }
  if (path === "/ui/admin") {
    return <AuthGate requiredRole="system_admin" requiredCapability="admin:read">{page}</AuthGate>;
  }
  if (path === "/ui/employee-access") {
    return <AuthGate requiredRole="owner_group" requiredCapability="access:admin">{page}</AuthGate>;
  }
  if (path === "/ui/management") {
    return <AuthGate requiredCapability="dashboard:management:read">{page}</AuthGate>;
  }
  if (path === "/ui/supervisor") {
    return <AuthGate requiredCapability="dashboard:site:read">{page}</AuthGate>;
  }
  if (path === "/ui/tasks") {
    return <AuthGate requiredAnyOf={[
      { requiredCapability: "dashboard:management:read" },
      { requiredCapability: "dashboard:site:read" },
      { requiredCapability: "report:view" },
    ]}>{page}</AuthGate>;
  }
  if (path === "/ui/reports") {
    return <AuthGate requiredCapability="report:view">{page}</AuthGate>;
  }
  return <AuthGate>{page}</AuthGate>;
}
