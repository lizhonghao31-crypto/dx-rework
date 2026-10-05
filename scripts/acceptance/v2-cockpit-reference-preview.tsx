// Reusable visual fixture host: renders the same Shell and cockpit as production.
import {useState} from "react";
import {createRoot} from "react-dom/client";
import {ProductionWorkspace} from "@dx-rework/ui/production";
import type {JourneyResult, OrderJourney} from "@dx-rework/contracts/digital-production-journey";
import {Shell} from "../../apps/web/src/components.js";
import {DigitalJourneyCockpit} from "../../apps/web/src/digital-journey-cockpit.js";
import {cockpitContext, type CockpitContext} from "../../apps/web/src/digital-journey-cockpit-model.js";
import "@dx-rework/ui/tokens.css";
import "@dx-rework/ui/components.css";
import "../../apps/web/src/styles.css";
import "../../apps/web/src/workflow-shell.css";
import "../../apps/web/src/dialog-visual-system.css";
import "../../apps/web/src/workflow-state-visual.css";
import "../../apps/web/src/ui-polish.css";
import "../../apps/web/src/digital-cockpit.css";
const snapshot = JSON.parse(document.getElementById("journey-fixture")!.textContent!) as {data: JourneyResult; detail: OrderJourney};
function ReferencePreview() {
  const [context, setContext] = useState<CockpitContext>(cockpitContext("?search=TEST-V2-PLAN"));
  return <Shell active="生产管理座舱" appearance="digital"><ProductionWorkspace><div className="digital-cockpit"><DigitalJourneyCockpit data={snapshot.data} detail={context.selected ? snapshot.detail : null} context={context} error="" detailError="" detailLoading={false} actions={null} onChange={(patch, preserve) => setContext(current => ({...current, ...patch, ...(!preserve ? {selected: undefined, expanded: undefined, focus: undefined, round: undefined} : {})}))}/></div></ProductionWorkspace></Shell>;
}
createRoot(document.getElementById("root")!).render(<ReferencePreview/>);
