import { Dashboard, Detail, Foundation, MobileForm, Tasks } from "./pages.js";

export function App() {
  const path = window.location.pathname;
  if (path === "/ui/management") return <Dashboard />;
  if (path === "/ui/supervisor") return <Dashboard supervisor />;
  if (path === "/ui/tasks") return <Tasks />;
  if (path.startsWith("/ui/tasks/")) return <Detail />;
  if (path === "/ui/qc/new") return <MobileForm />;
  if (path === "/ui/piecework/collective") return <MobileForm piecework />;
  if (path === "/system/foundation") return <Foundation />;
  return <Foundation />;
}
