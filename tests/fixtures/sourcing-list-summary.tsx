import { createRoot } from "react-dom/client";
import { SourcingWorkspacePage } from "../../apps/web/src/sourcing-workspace-page.js";
import "../../packages/ui/src/tokens.css";
import "../../apps/web/src/styles.css";
createRoot(document.getElementById("root")!).render(<SourcingWorkspacePage view="pending" />);
