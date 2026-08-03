import { Dashboard, Detail, Foundation, MobileForm, Tasks } from "./pages.js";
import { AuthGate, DeniedPage, LoginPage, QrLoginPage } from "./auth.js";
import { ReworkInitiationForm } from "./rework-form.js";
import { ProcessConfigurationForm } from "./process-configuration-form.js";
import { ResponsibilityQueuePage } from "./responsibility-queue-page.js";
import { WorkReportingForm } from "./work-reporting-form.js";

export function App() {
  const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
  const path = window.location.pathname.startsWith(basePath)
    ? window.location.pathname.slice(basePath.length) || "/"
    : window.location.pathname;
  if (path === "/auth/login") return <LoginPage />;
  if (path === "/auth/denied") return <DeniedPage />;
  if (path === "/auth/qr") return <QrLoginPage />;
  let page;
  if (path === "/ui/management") page = <Dashboard />;
  else if (path === "/ui/supervisor") page = <Dashboard supervisor />;
  else if (path === "/ui/responsibility") page = <ResponsibilityQueuePage />;
  else if (path === "/ui/tasks") page = <Tasks />;
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
    // Rework-order and process-scoped delegations cannot be evaluated from the
    // session-wide capability list. The workspace contains no protected data
    // until its API calls independently authorize the concrete rework order.
    return <AuthGate>{page}</AuthGate>;
  }
  return <AuthGate>{page}</AuthGate>;
}
