import {customerPoDateLabel} from './digital-workspace-copy.js';
import {Button} from '@dx-rework/ui';
import type {DevelopmentWorkspaceItem} from '@dx-rework/contracts/digital-development-workspace';
import type {DevelopmentSheet} from '@dx-rework/contracts/digital-development';
import type {DigitalOrder} from '@dx-rework/contracts/digital-production';
const date=(value:string|null|undefined)=>!value?'未登记':/^\d{4}-\d{2}-\d{2}$/.test(value)?value:new Date(value).toLocaleDateString('sv-SE',{timeZone:'Asia/Shanghai'});
export function DevelopmentOrderArchive({item,sheet,order,sheetError,orderError,sourceUrl,canConfirm,onConfirm}:{item:DevelopmentWorkspaceItem;sheet:DevelopmentSheet|undefined;order:DigitalOrder|undefined;sheetError:string|undefined;orderError:string|undefined;sourceUrl:string|null;canConfirm:boolean;onConfirm:()=>void}){
 const journey=item.journey,doc=sheet?.document;
 return <div className="development-order-archive" aria-label="订单档案只读资料">
  <h3>订单档案</h3>{sheetError&&<p role="alert">开发资料读取失败：{sheetError}</p>}{orderError&&<p role="alert">订购尺码资料读取失败：{orderError}</p>}
  <div className="order-archive-summary">
   <section><h4>基础资料</h4><dl><dt>款号</dt><dd>{journey.designStyleNo}</dd><dt>款名</dt><dd>{journey.styleName??'未登记'}</dd><dt>客户</dt><dd>{journey.customer??'通用开发'}</dd><dt>产品类别</dt><dd>{journey.category??'未登记'}</dd><dt>开发类型</dt><dd>{sheet?.developmentType??journey.developmentType??'未登记'}</dd><dt>设计师</dt><dd>{journey.designer??'未登记'}</dd></dl></section>
   <section><h4>开发资料</h4><dl><dt>发布状态</dt><dd>{sheet?sheet.status==='published'?'已发布':'草稿':sheetError?'读取失败':'读取中'}</dd><dt>本轮要求完成</dt><dd>{date(doc?.returnDate)}</dd><dt>本轮打板数量</dt><dd>{doc?.quantity??'未登记'}</dd><dt>本轮打样尺码</dt><dd>{doc?.sampleSize||'未登记'}</dd><dt>工艺 / 洗水</dt><dd>{doc?`${doc.craft} / ${doc.washing}`:'未登记'}</dd><dt>面辅料</dt><dd>{doc?.materials.filter(material=>material.requiredThisRound).map(material=>`${material.category}：${material.name||material.label}`).join('；')||'未登记'}</dd></dl>{sourceUrl&&<a href={sourceUrl}>本单资料 · 开发单 / 附件</a>}</section>
   <section><h4>订单信息</h4><dl><dt>确定客户订单</dt><dd>{journey.orderId?'有':'无'}</dd><dt>订购数量</dt><dd>{journey.orderId?journey.lines.reduce((sum,line)=>sum+line.orderedQuantity,0).toLocaleString():'尚无确定订单'}</dd><dt>PO / 颜色数</dt><dd>{journey.orderId?journey.lines.length:'—'}</dd><dt>创建日期</dt><dd>{date(journey.createdAt)}</dd></dl>{canConfirm&&<Button variant="primary" onClick={onConfirm}>客户确定订单</Button>}<p>订单资料只读，变更沿原业务页面与审批办理。</p></section>
  </div>
  {doc?.instructions&&<section className="order-archive-notes"><h4>制作说明</h4><p>{doc.instructions}</p></section>}
  {journey.orderId?<section className="order-archive-po"><h4>当前履约 PO / 颜色 / 数量 / 交期（{journey.lines.length}）</h4><div className="order-archive-po-scroll" tabIndex={0} aria-label="逐PO数量与日期"><table><thead><tr><th>正式款号 / PO</th><th>颜色</th><th>每码数量</th><th>合计</th><th>{customerPoDateLabel}</th><th>加工厂交货日</th><th>船样目标日</th></tr></thead><tbody>{journey.lines.map(line=>{
   const sizes=order?.lines.find(item=>item.lineId===line.id)?.sizes,dates=journey.poDeliveryDates?.find(item=>item.lineId===line.id);
   return <tr key={line.id}><td>{line.formalStyleNo||line.po||line.temporaryStyleNo||'未登记'}</td><td>{line.color}</td><td>{sizes?sizes.map(size=>`${size.size}：${size.quantity.toLocaleString()}`).join(' · '):orderError?'读取失败':order?'未登记':'读取中…'}</td><td>{line.orderedQuantity.toLocaleString()}</td><td>{dates?.customerWarehouseArrivalDate||'未登记'}</td><td>{dates?.factoryDeliveryDate||'未登记'}</td><td>{dates?.sampleTargetDate||'未登记'}</td></tr>;
  })}</tbody></table></div></section>:<p className="order-archive-orderless">此开发档案尚无确定客户订单。</p>}
  <section className="order-archive-versions"><h4>资料版本与采用轮次</h4><p>当前查看开发第 {sheet?.roundNumber??journey.selectedRound??1} 轮 · {sheet?.version?`资料版本 ${sheet.version}`:'资料尚未保存'} · {journey.adoptedRound?`大货采用第 ${journey.adoptedRound} 轮`:'尚未登记大货采用轮次'}</p>{doc?.files.length?<p>附件：{doc.files.map(file=>file.kind).join('、')}（按原单权限查看）</p>:null}{sourceUrl&&<a href={sourceUrl}>本单资料 · 版本历史 / 复版</a>}</section>
 </div>;
}
