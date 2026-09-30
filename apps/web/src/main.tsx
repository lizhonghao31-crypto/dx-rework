import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.js";
import { AcceptanceLabPage } from "./acceptance-lab-page.js";
import "@dx-rework/ui/tokens.css";
import "@dx-rework/ui/components.css";
import "./styles.css";
import "./responsibility-determination.css";
import "./workflow-shell.css";
import "./dialog-visual-system.css";
import "./workflow-state-visual.css";
import "./ui-polish.css";

const AcceptanceProductionCommandCenterPage = lazy(async () => {
  const module = await import("./acceptance-production-command-center-page.js");
  return { default: module.AcceptanceProductionCommandCenterPage };
});

const root = document.getElementById("root");
if (!root) throw new Error("Root element is missing");

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
const acceptanceLabPath = `${basePath}/ui/acceptance-lab`;
const acceptanceCommandCenterPath = `${basePath}/ui/acceptance/production-command-center`;
const page = window.location.pathname === acceptanceLabPath
  ? <AcceptanceLabPage />
  : window.location.pathname === acceptanceCommandCenterPath
    ? <Suspense fallback={null}><AcceptanceProductionCommandCenterPage /></Suspense>
    : <App />;

createRoot(root).render(
  <StrictMode>
    {page}
  </StrictMode>,
);
