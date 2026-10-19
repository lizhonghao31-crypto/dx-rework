// Real hosts; all names, files and responses are synthetic.
import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {DevelopmentCreateForm} from '../../apps/web/src/digital-development-create-form.js';
import {initialDevelopmentDocument} from '../../apps/web/src/digital-development-editing.js';
import {DevelopmentDocumentFacts} from '../../apps/web/src/development-document-facts.js';
import {PatternMaterials} from '../../apps/web/src/pattern-materials.js';
import {AttachmentIdentity} from '../../apps/web/src/attachment-identity.js';
import type {DevelopmentSheet} from '@dx-rework/contracts/digital-development';
import '../../packages/ui/src/tokens.css';
import '../../packages/ui/src/components.css';
import '../../apps/web/src/styles.css';
import '../../apps/web/src/workflow-shell.css';
import '../../apps/web/src/ui-polish.css';
import '../../apps/web/src/pattern-room.css';
import '../../apps/web/src/pattern-governed.css';
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,now='2026-10-17T00:00:00Z';
const long='TEST 中文English_款图工艺尺寸1234567890_'.repeat(5)+'.png',short='TEST-short.png',mode=new URLSearchParams(location.search).get('mode')??'development';
const state={long,short,requests:[] as {path:string;method:string}[],fail:mode==='failure',releaseOld:null as (()=>void)|null};Object.assign(window,{attachmentIdentityFixture:state});
const document={...initialDevelopmentDocument(),files:[{attachmentId:id(4),kind:'款图' as const},{attachmentId:id(5),kind:'款图' as const}]};
const sheet={sourceId:id(2),designStyleNo:'TEST-ATTACHMENTS',temporaryStyleNo:null,customerCode:'TEST',developmentType:'头版',designerName:'TEST 设计师',version:1,status:'draft',document,publishedAt:null,taskId:null,canEdit:true,materialEvents:[],roundNumber:1,latestRoundNumber:1} as DevelopmentSheet;
window.fetch=async(input,init)=>{const path=new URL(String(input),location.href).pathname,method=init?.method??'GET';state.requests.push({path,method});if(method!=='GET')throw Error('TEST fixture permits reads only');
 if(path.endsWith('/metadata')){if(state.fail){state.fail=false;return Response.json({error:{message:'Attachment access denied'}},{status:403});}if(path.includes(id(9)))await new Promise<void>(resolve=>state.releaseOld=resolve);return Response.json({filename:path.includes(id(5))?short:path.includes(id(9))?'TEST-OLD.png':long,mimeType:'image/png',sizeBytes:1234});}
 if(path.endsWith('/category-options'))return Response.json([{priceId:id(3),name:'TEST 上衣',unit:'件'}]);
 if(path.endsWith('/development'))return Response.json(sheet);
 if(path.endsWith('/execution'))return Response.json({sheet,tasks:[],patternOrder:null,routeFacts:[{factId:id(7),taskId:null,routeVersion:1,kind:'纸样完成',payload:{attachmentIds:[id(4)],note:'TEST 本轮已提交成果'},recordedAt:now}],facts:[]});
 return Response.json({error:{message:'TEST unmapped read'}},{status:404});};
function Race(){const [current,setCurrent]=useState(id(9));return <main style={{maxWidth:320,padding:16}}><button onClick={()=>setCurrent(id(4))}>TEST 换到当前附件</button><AttachmentIdentity label="附件" metadataPath={`sources/${id(2)}/development/attachments/${current}/metadata`}/></main>;}
createRoot(window.document.getElementById('root')!).render(mode==='materials'?<main className="pattern-detail" style={{padding:16,maxWidth:800}}><PatternMaterials files={[{attachmentId:id(4),filename:long,mimeType:'image/png'},{attachmentId:id(5),filename:short,mimeType:'image/png'}]}/></main>:mode==='results'?<main style={{padding:16,maxWidth:600}}><DevelopmentDocumentFacts sourceId={id(2)} round={1} category="results"/></main>:mode==='failure'?<main style={{padding:16,maxWidth:320}}><AttachmentIdentity label="附件" metadataPath={`sources/${id(2)}/development/attachments/${id(4)}/metadata`}/></main>:mode==='race'?<Race/>:<DevelopmentCreateForm intent="development" existingDraft={sheet} customers={[]} serverToday="2026-10-17" onCancel={()=>{}} onCreated={()=>{}}/>);
