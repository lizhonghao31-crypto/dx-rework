import type {OrderJourney} from "@dx-rework/contracts/digital-production-journey";
export const COCKPIT_DOCUMENT_CATEGORIES=[
 {key:"development",label:"开发单"},{key:"pattern",label:"样衣打板执行单"},{key:"misc",label:"关联打板杂事单"},{key:"order",label:"订购信息与PO"},{key:"budget",label:"预算单"},{key:"instruction",label:"大货制单"},{key:"contract",label:"外发合同"},{key:"preparation",label:"大货产前准备"},{key:"cutting",label:"裁床单"},{key:"factory",label:"裁后工艺与发厂资料"},{key:"receiving",label:"回货与装箱资料"},
] as const;
export type CockpitDocumentCategory=typeof COCKPIT_DOCUMENT_CATEGORIES[number]["key"];
export type CockpitDocumentFile={id:string;name:string;path:string|null;note?:string|undefined;at?:string|undefined;by?:string|undefined};
export type CockpitDocumentMetadataFact={label:string;at:string;by:string};
export type CockpitDocumentEntry={id:string;label:string;url?:string;note?:string|undefined;at?:string|undefined;by?:string|undefined;metadata?:CockpitDocumentMetadataFact[];files?:CockpitDocumentFile[];children?:CockpitDocumentEntry[];load?:{kind:string;path:string;id:string;version?:number|undefined;round?:string|undefined}};
export type CockpitDocumentResult={state:"created"|"missing"|"not_applicable"|"unknown";entries:CockpitDocumentEntry[];note?:string;nextPage?:number|null};
export type CockpitDocumentReader=(path:string,signal:AbortSignal)=>Promise<unknown>;
type Row=Record<string,unknown>;
const row=(value:unknown):Row=>value!==null&&typeof value==="object"&&!Array.isArray(value)?value as Row:{};
const rows=(value:unknown):Row[]=>Array.isArray(value)?value.map(row):[];
const str=(value:unknown)=>typeof value==="string"?value:"";
const num=(value:unknown)=>typeof value==="number"?value:0;
const strings=(value:unknown)=>Array.isArray(value)?value.filter((v):v is string=>typeof v==="string"):[];
const file=(id:string,name:string,path:string|null,note?:string):CockpitDocumentFile=>({id,name,path,...(note?{note}:{})});
const apiFile=(id:string,name:string)=>file(id,name,`tools/attachments/${id}/download?mode=preview`);
const result=(entries:CockpitDocumentEntry[],note?:string):CockpitDocumentResult=>({state:entries.length?"created":"missing",entries,...(note?{note}:{})});
const approvalStatuses:Record<string,string>={pending:"待审批",pending_management:"待审批",approved:"已批准",rejected:"已退回",cancelled:"已取消"};
const requireFields=(value:Row,fields:string[])=>{if(fields.some(field=>!Object.hasOwn(value,field)))throw new Error("资料返回不完整，请刷新重试");};
// HTTP success alone is not evidence that a collection is empty. Validate before
// converting metadata into an existence fact (the snapshot evicts rejected reads).
const invalidMetadata=():never=>{throw new Error("资料返回类型异常，尚不能确认是否已创建；请重试读取目录");};
const objectValue=(value:unknown):value is Row=>value!==null&&typeof value==="object"&&!Array.isArray(value);
const textValue=(value:unknown)=>typeof value==="string"&&value.length>0;
const integerValue=(value:unknown)=>typeof value==="number"&&Number.isSafeInteger(value)&&value>=0;
const positiveValue=(value:unknown)=>integerValue(value)&&(value as number)>0;
const nullableText=(value:unknown)=>value===null||textValue(value);
const checkedRows=(value:unknown,valid:(item:Row)=>boolean=()=>true):Row[]=>{
 if(!Array.isArray(value)||!value.every(item=>objectValue(item)&&valid(item)))return invalidMetadata();return value as Row[];
};
const checkedNumbers=(value:unknown):number[]=>{if(!Array.isArray(value)||!value.every(positiveValue))return invalidMetadata();return value as number[];};
const check=(valid:boolean)=>{if(!valid)invalidMetadata();};
const sameEntity=(value:Row,key:string,expected:string,label:string)=>{requireFields(value,[key]);if(value[key]!==expected)throw new Error(`${label}与本单不一致，本次未确认；请刷新后从原单进入`);};
const na=():CockpitDocumentResult=>({state:"not_applicable",entries:[],note:"当前没有此类业务来源。"});
const records=(order:OrderJourney,domain:string)=>[...new Map([...order.links,...order.stages.flatMap(stage=>stage.nodes.flatMap(node=>node.records))].filter(record=>record.domain===domain&&record.url).map(record=>[record.id,record])).values()];
const original=(kind:string,id:string,version?:number|undefined)=>`/ui/digital-production?${kind}=${id}${version?`&${kind==="development"?"round":kind==="budget"?"budgetVersion":"instructionVersion"}=${version}`:""}`;

/** Original readers authorize each request. Directory metadata may be read ahead; versions/files remain on demand. */
export async function loadCockpitDocumentCategory(order:OrderJourney,key:CockpitDocumentCategory,read:CockpitDocumentReader,signal:AbortSignal,page=1):Promise<CockpitDocumentResult>{
 const sid=order.sourceId,oid=order.orderId;
 if(key==="development"){
  if(!sid)return na();
  const sheet=row(await read(`digital-production/sources/${sid}/development`,signal)),roundsResult=row(await read(`digital-production/sources/${sid}/development/rounds`,signal));
  // The authorized reader requires the base document before returning a revision; the revisions table starts at round 2.
  requireFields(sheet,["sourceId","version","document"]);sameEntity(sheet,"sourceId",sid,"开发资料");requireFields(roundsResult,["rounds"]);check(integerValue(sheet.version)&&(sheet.document===null||objectValue(sheet.document))&&(sheet.roundNumber===undefined||positiveValue(sheet.roundNumber)));const rounds=checkedRows(roundsResult.rounds,item=>positiveValue(item.roundNumber)),numbers=[...new Set([...(sheet.document?[1]:[]),num(sheet.roundNumber)||1,...rounds.map(item=>num(item.roundNumber))])].filter(Boolean).sort((a,b)=>b-a);
  if(!sheet.document&&!rounds.length)return result([]);
  return result(numbers.map(roundNumber=>{const metadata=rounds.find(item=>item.roundNumber===roundNumber);return {id:`round:${roundNumber}`,label:`第 ${roundNumber} 轮${roundNumber===sheet.roundNumber?` · 单据 v${sheet.version} · ${sheet.status==="published"?"已发布":"草稿"}`:""}`,url:original("development",sid,roundNumber),at:str(metadata?.publishedAt),load:{kind:"development",path:`digital-production/sources/${sid}/development?round=${roundNumber}`,id:sid,version:roundNumber}};}));
 }
 if(key==="pattern"||key==="misc"){
  if(!sid&&!oid)return na();const query=new URLSearchParams({...(sid?{sourceId:sid}:{}),...(oid?{orderId:oid}:{}),page:String(page)}),data=row(await read(`pattern-room/related-orders?${query}`,signal));
  requireFields(data,["items","nextPage"]);check(data.nextPage===null||positiveValue(data.nextPage));const items=checkedRows(data.items,item=>textValue(item.orderId)&&textValue(item.orderNo)&&(item.kind==="pattern"||item.kind==="misc"));for(const item of items)checkedRows(item.rounds,round=>textValue(round.roundId)&&(round.roundType==="initial"||round.roundType==="rework")&&(round.roundIndex===null||integerValue(round.roundIndex)));const entries=items.filter(item=>item.kind===key).map(item=>({id:str(item.orderId),label:str(item.orderNo),at:str(item.createdAt),by:str(item.createdBy),children:rows(item.rounds).map(round=>({id:str(round.roundId),label:`${round.roundType==="rework"?"复版":"初始"}轮${round.roundIndex?` ${round.roundIndex}`:""}`,url:`/ui/pattern-room/orders/${item.orderId}?round=${round.roundId}`,at:str(round.requestedAt),load:{kind:"pattern",path:`pattern-room/orders/${item.orderId}?round=${round.roundId}`,id:str(item.orderId),round:str(round.roundId)}}))}));
  return {...result(entries,key==="misc"?"已关联本开发单或PO的杂事记录。":"原打板单与对应轮次资料。"),state:!entries.length&&typeof data.nextPage==="number"?"unknown":entries.length?"created":"missing",nextPage:typeof data.nextPage==="number"?data.nextPage:null};
 }
 if(!oid)return na();
 if(key==="order"){
  const sheet=row(await read(`digital-production/orders/${oid}`,signal)),instruction=row(await read(`digital-production/orders/${oid}/instruction`,signal));
  sameEntity(sheet,"productionOrderId",oid,"订购资料");sameEntity(row(instruction.order),"productionOrderId",oid,"制单日期资料");
  const lines=checkedRows(sheet.lines,line=>textValue(line.lineId));for(const line of lines)checkedRows(line.sizes,size=>textValue(size.size)&&integerValue(size.quantity));const changes=checkedRows(instruction.dateRequests,change=>textValue(change.requestId));for(const change of changes)checkedRows(change.changes,line=>textValue(line.lineId));
  return result([{id:oid,label:"订购信息与PO明细",url:original("order",oid),note:`母单 v${sheet.version??"待核实"}`,at:str(sheet.createdAt),children:lines.map(line=>({id:str(line.lineId),label:`${str(line.poNumber)||"PO待补"} · ${str(line.color)}`,note:rows(line.sizes).map(size=>`${size.size}：${size.quantity}`).join("；")}))},...changes.map(change=>({id:str(change.requestId),label:`出货日期变更 · ${approvalStatuses[str(change.status)]??"状态待核实"}`,url:original("instruction",oid),at:str(change.requestedAt),by:str(change.requestedBy),note:[str(change.reason),change.decidedAt?`处理：${str(change.decidedBy)} · ${str(change.decidedAt)}`:""].filter(Boolean).join("；"),children:rows(change.changes).map(line=>({id:str(line.lineId),label:str(line.poNumber)||"PO待补",note:`${str(line.oldDate)||"未登记"} → ${str(line.date)}`}))}))]);
 }
 if(key==="budget"||key==="instruction"){
  const path=`digital-production/orders/${oid}/${key}`,sheet=row(await read(path,signal));
  requireFields(sheet,["version","versions"]);sameEntity(key==="budget"?sheet:row(sheet.order),"productionOrderId",oid,key==="budget"?"预算资料":"制单资料");check(integerValue(sheet.version));const versions=checkedNumbers(sheet.versions),current=num(sheet.version);
  const entries:CockpitDocumentEntry[]=versions.map(version=>({id:`published:${version}`,label:`已发布 v${version}`,url:original(key,oid,version),load:{kind:key,path:`${path}?version=${version}`,id:oid,version}}));
  if(current&&!versions.includes(current))entries.unshift({id:`draft:${current}`,label:`当前草稿 v${current}`,url:original(key,oid),load:{kind:key,path,id:oid}});
  return result(entries);
 }
 if(key==="contract"){
  const sources=records(order,"sourcing");if(!sources.length)return {state:"unknown",entries:[],note:"暂无可读取的合同关联。"};
  const entries:CockpitDocumentEntry[]=[];
  for(const source of sources){const directory=row(await read(`sourcing/cases/${source.id}/contract-directory`,signal)),returned={versions:directory.versions,history:undefined,attachments:undefined},versions=checkedRows(directory.versions,version=>positiveValue(version.revision)&&nullableText(version.signedContractDocumentId));
   requireFields(directory,["contracts","versions"]);const contracts=checkedRows(directory.contracts,contract=>textValue(contract.entryId)&&positiveValue(contract.version));for(const version of versions)checkedRows(version.attachments,item=>textValue(item.attachmentId)&&textValue(item.filename));
   for(const contract of contracts){const documentId=str(contract.entryId);entries.push({id:documentId,label:`合同 v${contract.version}`,at:str(contract.handledAt),by:str(contract.handledBy),url:`/ui/sourcing/orders/${source.id}#contract-${documentId}`,note:contract.pdfAttachmentId?contract.pdfStatus==="ready"?"":"原合同PDF暂不可用":"此版PDF尚未生成",files:contract.pdfAttachmentId?[file(str(contract.pdfAttachmentId),str(contract.pdfFilename)||`合同 v${contract.version}`,contract.pdfStatus==="ready"?`tools/attachments/${contract.pdfAttachmentId}/download?mode=preview`:null)]:[],children:versions.filter(version=>version.signedContractDocumentId===documentId).map(version=>({id:`return:${version.revision}`,label:`回签第 ${version.revision} 次`,at:str(version.submittedAt),by:str(version.uploadedByName),files:rows(version.attachments).map(item=>apiFile(str(item.attachmentId),str(item.filename)))}))});}
   const unbound=versions.filter(version=>!version.signedContractDocumentId);if(unbound.length)entries.push({id:`unbound:${source.id}`,label:"历史回签归属待核实",note:"原记录未保存合同文档编号，不分配给当前合同。"});
   if(!returned.versions&&(rows(returned.history).length||rows(returned.attachments).length))entries.push({id:`old-api:${source.id}`,label:"回签版本资料待完善",note:"当前接口未提供完整回签修订目录，请在原合同区核对。"});
  }return result(entries);
 }
 if(key==="preparation"){
  const sheet=row(await read(`digital-production/orders/${oid}/bulk-preparation`,signal));requireFields(sheet,["preparationId"]);sameEntity(sheet,"orderId",oid,"产前资料");check(nullableText(sheet.preparationId));if(!sheet.preparationId)return result([]);checkedRows(sheet.facts,fact=>textValue(fact.kind));checkedRows(sheet.tasks,task=>textValue(task.taskId)&&textValue(task.label));
  return result([{id:str(sheet.preparationId),label:"产前准备记录",url:original("bulk",oid),note:`制单 v${sheet.instructionVersion??"未核实"} · 开发第 ${sheet.sourceRound??"未核实"} 轮`,children:[...rows(sheet.facts).map((fact,index)=>({id:`fact:${index}`,label:str(fact.kind),at:str(fact.recordedAt)})),...rows(sheet.tasks).map(task=>({id:str(task.taskId),label:str(task.label),url:`/ui/digital-production?task=${task.taskId}&taskView=read`,note:str(task.assigneeName)||"负责人未登记"}))]}],"派工、唛架和预缩记录。");
 }
 if(key==="cutting"){
  const sources=records(order,"cutting");return sources.length?result(sources.map(source=>({id:source.id,label:"裁床单",url:`/ui/cutting/orders/${source.id}`,load:{kind:"cutting",path:`cutting/orders/${source.id}`,id:source.id}}))):{state:"unknown",entries:[],note:"裁床关联尚未确认。"};
 }
 if(key==="factory"){
  const sheet=row(await read(`digital-production/orders/${oid}/factory-flow`,signal));requireFields(sheet,["preparationId"]);sameEntity(sheet,"orderId",oid,"裁后工艺资料");check(nullableText(sheet.preparationId));if(!sheet.preparationId)return result([]);checkedRows(sheet.facts,fact=>textValue(fact.factId)&&textValue(fact.kind));for(const item of checkedRows(sheet.checks,item=>textValue(item.checkId)))check(Array.isArray(item.attachmentIds)&&item.attachmentIds.every(textValue));
  return result([...rows(sheet.facts).map(fact=>({id:str(fact.factId),label:str(fact.kind),url:original("factory",oid)+`#fact-${fact.factId}`,at:str(fact.recordedAt),by:str(fact.actorName),note:`发生：${str(fact.occurredAt)||"未核实"}${row(fact.payload).note?`；${row(fact.payload).note}`:""}${row(fact.payload).trackingNumber?`；快递：${row(fact.payload).trackingNumber}`:""}`})),...rows(sheet.checks).map(check=>({id:str(check.checkId),label:`工艺检查 · ${str(check.result)}`,url:original("factory",oid)+`#check-${check.checkId}`,at:str(check.checkedAt),by:str(check.checkedBy),note:[str(check.problem),str(check.treatment)].filter(Boolean).join("；"),files:strings(check.attachmentIds).map((id,index)=>file(id,`检查图片 ${index+1}`,`digital-production/orders/${oid}/factory-flow/attachments/${id}`))}))],"工艺收发、检查复查、实际发厂与寄样记录。");
 }
 const closure=row(await read(`digital-production/orders/${oid}/closure`,signal)),lines=checkedRows(closure.lines,line=>textValue(line.lineId)&&nullableText(line.receivingBatchId)),ids=[...new Set(lines.map(line=>str(line.receivingBatchId)).filter(Boolean))];
 requireFields(closure,["orderId","lines","closed"]);if(closure.orderId!==oid)throw new Error("订单资料不匹配，请返回来源核对");const entries:CockpitDocumentEntry[]=ids.map(id=>({id,label:lines.filter(line=>line.receivingBatchId===id).map(line=>`${str(line.poNumber)||"PO待补"} · ${str(line.color)}`).join(" / "),url:original("closure",oid),load:{kind:"receiving",path:`receiving/batches/${id}/document-history`,id}}));
 check(closure.closed===null||objectValue(closure.closed));if(closure.closed){const closed=row(closure.closed);check(Array.isArray(closed.outstanding)&&closed.outstanding.every(value=>typeof value==="string"));entries.push({id:"special-closure",label:"特殊结案记录",url:original("closure",oid),at:str(closed.closedAt),by:str(closed.closedBy),note:str(closed.reason),children:strings(closed.outstanding).map((label,index)=>({id:`outstanding:${index}`,label}))});}
 return result(entries);
}

export async function loadCockpitDocumentEntry(entry:CockpitDocumentEntry,read:CockpitDocumentReader,signal:AbortSignal):Promise<CockpitDocumentEntry>{
 if(!entry.load)return entry;const {kind,path,id,version,round}=entry.load,data=row(await read(path,signal));
 if(kind==="development"){
  if(num(data.roundNumber)!==version)throw new Error("找不到所选开发轮次，请返回原单核对");
  const execution=row(await read(`digital-production/sources/${id}/execution`,signal)),tasks=rows(execution.tasks),taskIds=new Set(tasks.filter(task=>task.routeVersion===version).map(task=>str(task.taskId)));
  const facts=rows(execution.facts).filter(fact=>taskIds.has(str(fact.taskId))),unbound=rows(execution.facts).filter(fact=>!fact.taskId);
  const doc=row(data.document);return {...entry,note:`单据 v${data.version} · ${data.status==="published"?"已发布":"草稿"}`,at:str(data.publishedAt),metadata:metadataFacts(data),files:rows(doc.files).filter(item=>item.kind!=="工艺开发板"||doc.craft!=="无").map(item=>file(str(item.attachmentId),`${item.kind}原件`,`digital-production/sources/${id}/development/attachments/${item.attachmentId}`)),children:[...rows(data.materialEvents).map(fact=>({id:str(fact.eventId),label:`材料 · ${str(fact.action)}`,at:str(fact.createdAt),note:str(fact.note)})),...facts.map(fact=>developmentFact(fact,id)),...rows(execution.routeFacts).filter(fact=>fact.routeVersion===version).map(fact=>({id:str(fact.factId),label:str(fact.kind),at:str(fact.recordedAt),note:str(row(fact.payload).note)})),...(unbound.length?[{id:"unbound-facts",label:"未记录轮次的开发资料",note:"保留来源，不能归入某一历史轮。",children:unbound.map(fact=>developmentFact(fact,id))}]:[])]};
 }
 if(kind==="pattern"){if(data.orderId!==id||!rows(data.rounds).some(item=>item.roundId===round))throw new Error("找不到所选打板轮次，请返回原单核对");return {...entry,files:rows(data.attachments).filter(item=>item.roundId===round).map(item=>file(str(item.attachmentId),str(item.filename),item.active?`pattern-room/attachments/${item.attachmentId}/download?mode=preview`:null,item.active?undefined:"原件已停用")),note:data.canReadMaterials===false?"当前身份无权读取此轮制作资料。":undefined};}
 if(kind==="budget"||kind==="instruction"){
  if(version&&num(data.version)!==version)throw new Error("找不到所选历史版本，请返回原单核对");
  const doc=row(data.document),files=kind==="budget"?strings(doc.imageAttachmentIds).map((attachmentId,index)=>file(attachmentId,`预算图片 ${index+1}`,`digital-production/orders/${id}/budget/attachments/${attachmentId}`)):rows(doc.images).map(image=>file(str(image.attachmentId),str(image.kind)||"制单原图",`digital-production/orders/${id}/instruction/attachments/${image.attachmentId}`));
  return {...entry,at:str(data.publishedAt),files,metadata:metadataFacts(data),note:kind==="instruction"?`采用开发第 ${data.sourceRound??"未核实"} 轮`:undefined};
 }
 if(kind==="cutting"){
  const record=row(data.record);return {...entry,at:str(record.recordedAt),by:str(record.recordedByName),note:record.version?`实裁 v${record.version} · 裁数 ${record.actualCutCount}`:"尚未登记实裁",files:rows(record.cuttingSheetPhotos??data.photos).map(image=>file(str(image.attachmentId),str(image.filename),`cutting/attachments/${image.attachmentId}/download?mode=preview`)),children:rows(record.corrections).map(correction=>({id:str(correction.correctionId),label:`实裁订正 v${correction.version??""}`,at:str(correction.correctedAt),by:str(correction.correctedByName),note:str(correction.reason)}))};
 }
 if(kind==="receiving"){
  const files=rows(data.files);return {...entry,files:files.filter(item=>strings(data.batchIds).includes(str(item.entityId))).map(receivingFile),children:[...rows(data.receipts).map(receipt=>({id:str(receipt.receiptId),label:`实收 ${receipt.actualQuantity} · 次品 ${receipt.defectiveQuantity}`,at:str(receipt.receivedAt),by:str(receipt.receivedBy),children:rows(data.corrections).filter(correction=>correction.receiptId===receipt.receiptId).map(correction=>({id:str(correction.id),label:`实收订正 ${correction.actualQuantity} · 次品 ${correction.defectiveQuantity}`,at:str(correction.at),by:str(correction.by)}))})),...rows(data.packing).map((packing,index)=>({id:str(packing.id),label:`装箱登记 ${index+1} · 数量 ${packing.quantity}`,at:str(packing.at),by:str(packing.by)})),...rows(data.resolutions).map(resolution=>({id:str(resolution.id),label:`${resolution.differenceType==="packing"?"装箱":"收货"}差异处理`,at:str(resolution.at),by:str(resolution.by),note:`${str(resolution.result)} · 原处理凭证，当前是否有效见原收尾页`,files:files.filter(item=>item.entityId===resolution.id).map(receivingFile)}))]};
 }return entry;
}
function developmentFact(fact:Row,sourceId:string):CockpitDocumentEntry{
 const payload=row(fact.payload),ids=[...strings(payload.attachmentIds),...strings(payload.imageAttachmentIds)];
 return {id:str(fact.factId),label:str(fact.kind),at:str(fact.recordedAt),note:[str(payload.note),str(payload.result),str(payload.trackingNumber)].filter(Boolean).join("；"),files:ids.map((id,index)=>file(id,`原成果 / 报告附件 ${index+1}`,`digital-production/sources/${sourceId}/development/attachments/${id}`))};
}
function receivingFile(item:Row):CockpitDocumentFile{return {...apiFile(str(item.id),str(item.filename)),path:item.retiredAt||item.status!=="ready"?null:`tools/attachments/${item.id}/download?mode=preview`,note:item.retiredAt?"原件已停用":item.status!=="ready"?"原件暂不可用":undefined,at:str(item.at),by:str(item.by)};}

function metadataFacts(data:Row):CockpitDocumentMetadataFact[]{
 const metadata=row(data.metadata);return ([['created','创建'],['edited','修改'],['published','发布']] as const).map(([key,label])=>{const fact=row(metadata[key]);return {label,at:str(fact.at)||(key==='published'?str(data.publishedAt):''),by:str(fact.by)};});
}

export type CockpitDirectoryState={phase:'idle'|'loading'|'ready'|'error';data?:CockpitDocumentResult;error?:string;denied?:boolean;resume?:CockpitDocumentResult};
export type CockpitDirectoryStates=Record<CockpitDocumentCategory,CockpitDirectoryState>;
export const emptyCockpitDirectoryStates=():CockpitDirectoryStates=>Object.fromEntries(COCKPIT_DOCUMENT_CATEGORIES.map(category=>[category.key,{phase:'idle'}])) as CockpitDirectoryStates;
const cancelledDirectoryRead=()=>Object.assign(new Error('本次目录读取已取消'),{name:'AbortError'});

/** Same original authorized readers; bounded directory pages, never file bytes. */
export async function loadCockpitDirectoryPages(order:OrderJourney,key:CockpitDocumentCategory,read:CockpitDocumentReader,signal:AbortSignal,budget=3,previous?:CockpitDocumentResult){
 let page=previous?.nextPage??1,data=previous;const seen=new Set<number>();
 for(let count=0;count<budget;count++){
  if(signal.aborted)throw cancelledDirectoryRead();
  if(!Number.isSafeInteger(page)||page<1||seen.has(page))throw new Error('关联目录分页异常，尚不能确认完整记录；请刷新核对');seen.add(page);
  const next=await loadCockpitDocumentCategory(order,key,read,signal,page),entries=[...(data?.entries??[])];
  for(const entry of next.entries)if(!entries.some(old=>old.id===entry.id))entries.push(entry);
  if(next.nextPage!==undefined&&next.nextPage!==null&&(!Number.isSafeInteger(next.nextPage)||next.nextPage<=page))throw new Error('关联目录分页未前进，请刷新核对；未按无记录处理');
  data={...next,entries,state:entries.length?'created':next.nextPage?'unknown':next.state};
  if(!next.nextPage)return data;page=next.nextPage;
 }
 return {...data!,note:data!.entries.length?'已查到本类资料，尚有后续关联记录，可继续读取。':'尚有后续关联记录未读取，暂不能确认是否存在本类资料。请选择继续读取。'};
}

/** Cache belongs to exactly one actor/snapshot. At most three original GETs
 * run at once; category and version readers share it, without caching denials. */
export function createCockpitDocumentSnapshot(order:OrderJourney,reader:CockpitDocumentReader,isCurrent:()=>boolean=()=>true){
 const snapshotOrder=structuredClone(order);
 const controller=new AbortController(),cache=new Map<string,Promise<unknown>>(),listeners=new Set<()=>void>(),queue:Array<{start:()=>void;reject:(reason:Error)=>void}>=[];
 let active=0,disposed=false,states=emptyCockpitDirectoryStates();
 const live=()=>!disposed&&!controller.signal.aborted&&isCurrent();
 const emit=()=>{for(const listener of listeners)listener();};
 const update=(key:CockpitDocumentCategory,state:CockpitDirectoryState)=>{if(live()){states={...states,[key]:state};emit();}};
 const pump=()=>{while(live()&&active<3&&queue.length)queue.shift()!.start();};
 const read:CockpitDocumentReader=(path,signal)=>{
  if(!live()||signal.aborted)return Promise.reject(cancelledDirectoryRead());
  let pending=cache.get(path);
  if(!pending){
   const request=new Promise<unknown>((resolve,reject)=>{queue.push({reject,start:()=>{active++;void(async()=>{try{if(!live())throw cancelledDirectoryRead();const value=await reader(path,controller.signal);if(!live())throw cancelledDirectoryRead();resolve(value);}catch(error){reject(error);}finally{active--;pump();}})();}});pump();});
   pending=request.catch(error=>{if(cache.get(path)===pending)cache.delete(path);if([401,403,404].includes((error as {status?:number}).status??0))cache.clear();throw error;});cache.set(path,pending);
  }
  return pending.then(value=>{if(!live()||signal.aborted)throw cancelledDirectoryRead();return value;});
 };
 const validated=async<T>(work:(tracked:CockpitDocumentReader)=>Promise<T>)=>{const used=new Set<string>();try{return await work((path,signal)=>{used.add(path);return read(path,signal);});}catch(error){for(const path of used)cache.delete(path);throw error;}};
 const load=async(key:CockpitDocumentCategory,more=false)=>{
  if(!live()||states[key].phase==='loading'||states[key].phase==='ready'&&!more)return;
  const prior=more?states[key].data:states[key].resume;
  if(more&&!prior?.nextPage)return;
  update(key,{phase:'loading',...(prior?{data:prior}:{})});
  try{const data=await validated(tracked=>loadCockpitDirectoryPages(snapshotOrder,key,tracked,controller.signal,3,prior));update(key,{phase:'ready',data});}
  catch(error){if(!live()||(error as Error).name==='AbortError')return;const status=(error as {status?:number}).status,denied=status===401||status===403;
   update(key,{phase:'error',denied,error:denied?'当前身份无权读取此类资料；未确认是否已创建。':status===404?'资料不存在或不在授权范围，无法确认是否已创建。':error instanceof Error?error.message:'目录读取失败，暂未确认原因；请重试，仍失败请管理员核对接口。',...(![401,403,404].includes(status??0)&&prior?{resume:prior}:{})});}
 };
 return {read,load,loadEntry:(entry:CockpitDocumentEntry,signal:AbortSignal)=>validated(tracked=>loadCockpitDocumentEntry(entry,tracked,signal)),start:()=>{for(const category of COCKPIT_DOCUMENT_CATEGORIES)void load(category.key);},getSnapshot:()=>states,subscribe:(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};},dispose:()=>{if(disposed)return;disposed=true;controller.abort();for(const job of queue.splice(0))job.reject(cancelledDirectoryRead());cache.clear();states=emptyCockpitDirectoryStates();emit();listeners.clear();}};
}
export type CockpitDocumentSnapshot=ReturnType<typeof createCockpitDocumentSnapshot>;
