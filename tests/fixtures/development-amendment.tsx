import {createRoot} from "react-dom/client";
import {DevelopmentAmendmentPanel} from "../../apps/web/src/development-amendment-panel.js";
import "../../packages/ui/src/tokens.css";
import "../../packages/ui/src/components.css";
import "../../apps/web/src/styles.css";
import "../../apps/web/src/digital-development.css";
createRoot(document.getElementById("root")!).render(<main style={{padding:16,maxWidth:1100}}><DevelopmentAmendmentPanel sourceId="00000000-0000-4000-8000-000000000001" taskId="00000000-0000-4000-8000-000000000002" onSubmitted={async()=>{throw Error("TEST刷新失败");}}/></main>);
