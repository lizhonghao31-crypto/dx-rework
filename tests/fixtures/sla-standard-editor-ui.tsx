import {createRoot} from 'react-dom/client';
import {CockpitProductionSettings} from '../../apps/web/src/cockpit-production-settings.js';
import {digitalSlaDefaults} from '@dx-rework/contracts/digital-sla';
import '../../packages/ui/src/tokens.css';import '../../packages/ui/src/components.css';import '../../apps/web/src/styles.css';
let values=digitalSlaDefaults(),version=1;const writes:unknown[]=[];Reflect.set(window,'slaWrites',writes);
window.fetch=async(path,init)=>{
 const url=String(path);if(url.endsWith('/access/options'))return Response.json({manage:!location.search.includes('readonly'),customers:false});
 if(url.endsWith('/sla-settings'))return Response.json({version,values,scope:'new_orders',history:[{version:1,reason:'初始标准'}]});
 const body=JSON.parse(String(init?.body));writes.push({url,body,key:new Headers(init?.headers).get('idempotency-key')});
 if(url.endsWith('/preview')){
  if(location.search.includes('conflict'))return Response.json({code:'DIGITAL_TASK_CONFLICT',message:'现行标准已改变，请重新预览'},{status:409});
  return Response.json({token:'a'.repeat(64),version,scope:'new_orders',existingOrdersChanged:0,changes:Object.entries(body.values).filter(([key,v])=>JSON.stringify(values[key])!==JSON.stringify(v)).map(([key,v])=>({key,label:key==='warning_ratio'?'节点临期比例':'节点工时',before:values[key],after:v}))});
 }
 if(url.endsWith('/publish')){values=body.values;version++;return Response.json({version,scope:'new_orders',existingOrdersChanged:0});}
 return Response.json({message:'unexpected'},{status:404});
};
createRoot(document.getElementById('root')!).render(<main className="dx-production-ui"><CockpitProductionSettings/></main>);
