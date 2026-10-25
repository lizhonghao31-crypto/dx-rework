import {createRoot} from 'react-dom/client';
import {OrderClosurePanel} from '../../apps/web/src/order-closure-panel.js';
import type {OrderClosureSheet} from '@dx-rework/contracts/order-closure';
import '../../packages/ui/src/tokens.css';import '../../packages/ui/src/components.css';import '../../apps/web/src/styles.css';
const sheet=Reflect.get(window,'factoryInput') as OrderClosureSheet;
sheet.canClose=false;const requests:unknown[]=[];Reflect.set(window,'qualityRequests',requests);window.fetch=async(_path,init)=>{if(init?.method==='POST'){const body=JSON.parse(String(init.body));requests.push(body);return Response.json({eventId:'00000000-0000-4000-8000-000000000001',receiptId:body.receiptId});}return Response.json(sheet);};
createRoot(document.getElementById('root')!).render(<main className="pattern-golden" style={{maxWidth:1200,margin:'0 auto',padding:16}}><OrderClosurePanel orderId={sheet.orderId} onClose={()=>undefined}/></main>);
