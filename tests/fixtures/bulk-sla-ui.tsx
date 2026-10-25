// Actual page, captured isolated PostgreSQL responses; no live business API.
import {createRoot} from 'react-dom/client';
import {BulkPreparationPanel} from '../../apps/web/src/bulk-preparation-panel.js';
import type {BulkPreparationSheet} from '@dx-rework/contracts/bulk-preparation';
import '../../packages/ui/src/tokens.css';
import '../../packages/ui/src/components.css';
import '../../apps/web/src/styles.css';
const input=Reflect.get(window,'bulkSlaInput') as Record<string,BulkPreparationSheet>;
const mode=new URLSearchParams(location.search).get('mode')??'warehouse';
const sheet=structuredClone(input[mode==='conflict'?'warehouse':mode]!);
sheet.reference.styleImageUrl=null;
if(sheet.fabric?.report)sheet.fabric.report.material+=' · 长面料名称测试'.repeat(8);
const requests:Array<{path:string;body:unknown}>=[];Reflect.set(window,'bulkSlaRequests',requests);
window.fetch=async(path,init)=>{
 const url=String(path);
 if(url.endsWith('/access/candidates'))return Response.json([]);
 if(init?.method&&init.method!=='GET'){
  requests.push({path:url,body:JSON.parse(String(init.body))});
  if(mode==='conflict')return Response.json({message:'验布报告已更新，请刷新'},{status:409});
 }
 return Response.json(sheet);
};
createRoot(document.getElementById('root')!).render(<main className="pattern-golden" style={{maxWidth:1200,margin:'0 auto',padding:16}}><BulkPreparationPanel orderId={sheet.orderId} onClose={()=>undefined} readonly={mode==='readonly'}/></main>);
