import React from "react";
import { createRoot } from "react-dom/client";
import {
  PRODUCTION_COMMAND_CENTER_DEMO_ORDERS,
  PRODUCTION_COMMAND_CENTER_DEMO_SELECTED,
  PRODUCTION_COMMAND_CENTER_DEMO_SUMMARY,
} from "../../apps/web/src/production-command-center-demo-data.js";
import { ProductionCommandCenterView } from "../../apps/web/src/production-command-center-view.js";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ProductionCommandCenterView
      summary={PRODUCTION_COMMAND_CENTER_DEMO_SUMMARY}
      orders={PRODUCTION_COMMAND_CENTER_DEMO_ORDERS}
      selectedOrderNo={PRODUCTION_COMMAND_CENTER_DEMO_SELECTED}
    />
  </React.StrictMode>,
);
