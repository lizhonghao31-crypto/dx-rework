import {ForegroundLoading} from "../../apps/web/src/foreground-loading.js";
import "../../apps/web/src/foreground-loading.css";
import '../../packages/ui/src/tokens.css';
import '../../packages/ui/src/components.css';
import '../../apps/web/src/styles.css';
import '../../apps/web/src/pattern-room.css';
import '../../apps/web/src/digital-production.css';
import '../../apps/web/src/digital-development.css';
import '../../apps/web/src/App.js';
import {createRoot} from 'react-dom/client';
import {useRef,useState} from 'react';
import {DevelopmentDocumentFields} from '../../apps/web/src/development-document-fields.js';
import {initialDevelopmentDocument} from '../../apps/web/src/digital-development-editing.js';
import type {AuxiliaryItem} from '@dx-rework/contracts/auxiliary-catalog';
import type {DevelopmentDocument} from '@dx-rework/contracts/digital-development';
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,mode=new URLSearchParams(location.search).get('mode')??'select';
const entry:AuxiliaryItem={id:id(1),version:1,name:'TEST扁机完整中文名称',specification:'TEST规格40厘米',auxiliaryKind:'扁机',active:true,mergedInto:null,changedAt:'2026-10-20T00:00:00Z'};
const fixture={requests:[] as {path:string;method:string;key:string|null;body:unknown}[],commits:0,parentSubmits:0,document:null as DevelopmentDocument|null};Object.assign(window,{auxiliaryFixture:fixture});let receipt:AuxiliaryItem|null=null;
let releaseDirectory!:()=>void;
const slowInitialDirectory=new Promise<void>(resolve=>{releaseDirectory=resolve;});
Object.assign(window,{releaseDirectory});
window.fetch=async(input,init)=>{const url=new URL(String(input),location.origin),method=init?.method??'GET',body=init?.body?JSON.parse(String(init.body)):null,key=new Headers(init?.headers).get('idempotency-key');fixture.requests.push({path:url.pathname,method,key,body});
 if(method==='GET'&&url.pathname.endsWith('/receipt'))return Response.json({receipt});
 if(method==='GET'&&url.pathname.endsWith('/auxiliaries')){if(mode==='denied')return Response.json({error:{message:'TEST当前账号无目录权限'}},{status:403});const q=url.searchParams.get('q')??'';if(mode==='wait'&&!q)await slowInitialDirectory;return Response.json({items:[...(entry.name.includes(q)?[entry]:[]),...(receipt&&receipt.name.includes(q)?[receipt]:[])],page:1,pageSize:15,total:1,canManage:true});}
 if(method==='POST'&&url.pathname.endsWith('/auxiliaries')){if(mode==='retry'&&fixture.requests.filter(r=>r.method==='POST').length===1)throw new TypeError('TEST response lost without receipt');fixture.commits++;receipt={...entry,...body,id:id(2)};if(mode==='timeout'&&fixture.commits===1)return Response.json({error:{message:'TEST响应超时，原提交仍待核对'}},{status:408});if(mode==='unknown'&&fixture.commits===1)throw new TypeError('TEST directory commit response lost');return Response.json(receipt);}
 throw Error(`Unexpected auxiliary fixture request: ${method} ${url.pathname}`);
};
function Fixture(){const [document,setDocument]=useState<DevelopmentDocument>(()=>JSON.parse(sessionStorage.getItem('TEST-P06-draft')??'null')??{...initialDevelopmentDocument(),materials:[{materialId:id(3),category:'辅料',label:'TEST原辅料',name:'TEST原自由文本',specification:'TEST原规格',supplier:'',width:'',weight:'',composition:'',consumption:'',color:'',quantity:'1',requiredThisRound:false,available:false,expectedDate:null}]});fixture.document=document;
 const [quantity,setQuantity]=useState(''),[counts,setCounts]=useState(['','']),[kind,setKind]=useState<DevelopmentDocument['files'][number]['kind']>('款图'),writing=useRef(false),measurementIds=useRef(document.measurements.map((_,i)=>id(100+i))),successfulUploads=useRef(new Map<string,string>());
 return <form className="digital-production dx-doc-development" onSubmit={event=>{event.preventDefault();fixture.parentSubmits++;sessionStorage.setItem('TEST-P06-draft',JSON.stringify(document));}}><h1>TEST 创建页原材料宿主</h1><DevelopmentDocumentFields document={document} edit={patch=>setDocument(old=>({...old,...patch}))} readonly={false} busy={false} writing={writing} quantityInput={quantity} setQuantityInput={setQuantity} sizeQuantityInputs={counts} setSizeQuantityInputs={setCounts} measurementIds={measurementIds} successfulUploads={successfulUploads} imageUrl={()=>''} upload={async()=>undefined} fileKind={kind} setFileKind={setKind} issue={()=>undefined}/><button type="submit">TEST保存订单草稿</button></form>;
}
createRoot(document.getElementById('root')!).render(<><ForegroundLoading/><Fixture/></>);
