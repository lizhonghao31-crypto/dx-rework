import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.js";
import "@dx-rework/ui/tokens.css";
import "@dx-rework/ui/components.css";
import "./styles.css";
import "./responsibility-determination.css";
import "./workflow-shell.css";
import "./dialog-visual-system.css";
import "./workflow-state-visual.css";

const root = document.getElementById("root");
if (!root) throw new Error("Root element is missing");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
