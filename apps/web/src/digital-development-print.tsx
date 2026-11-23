import {developmentMakingSizes} from "@dx-rework/contracts/digital-development";
import type { DevelopmentDocument, DevelopmentSheet } from "@dx-rework/contracts/digital-development";
import { washingChoiceLabel } from "./digital-workspace-copy.js";
export function DevelopmentPrint({sheet,document,imageUrl}:{sheet:DevelopmentSheet;document:DevelopmentDocument;imageUrl:(id:string)=>string}) {
  const details={"朴号":document.interlining,"门筒朴":document.placketInterlining,"车缝线":document.sewingThread,"纽门线":document.buttonholeThread,"针距":document.stitchDensity,...(document.washingIroning?{"原洗水整烫说明":document.washingIroning}:{}),...(document.washing!=="免洗"?{"洗水方法":document.washingMethod??""}:{}),"整烫方法":document.ironing??"","包装方法":document.packaging,"正装尺码":document.formalSizes,"休闲尺码":document.casualSizes,"主唛":document.mainLabel?"有":"无","主唛车法":document.mainLabelMethod,"码唛":document.sizeLabel?"有":"无","洗水唛":document.careLabel?"有":"无"};
  const groups=Array.from({length:Math.ceil(document.sizes.length/4)},(_,index)=>({offset:index*4,sizes:document.sizes.slice(index*4,index*4+4)}));
  return <article className="development-print"><header><h2>广州市达兴制衣有限公司</h2><h3>款式设计与制作说明单 · {document.template}</h3></header>
    <p>客户：{sheet.customerCode??"通用开发"} · 款号：{sheet.designStyleNo} · 代用号：{sheet.temporaryStyleNo??"—"} · {sheet.developmentType} · {sheet.status==="draft"?"草稿":"已发布"} · 第{sheet.roundNumber??1}轮 · 版本：{sheet.version}</p>
    <p>本轮打板数量：{document.quantity?.toLocaleString()??"—"} · 各码制作数量：{developmentMakingSizes(document)} · 设计师：{sheet.designerName} · 开发下单日期：{document.orderDate??"—"} · 预计样板完成日期：{document.returnDate??"—"}</p>
    {document.workbenchSheet&&<section><h4>版单基本资料</h4>
      <p>款名：{document.workbenchSheet.styleName||"未登记"} · 性别：{document.workbenchSheet.gender??"未登记"} · 板类：{document.workbenchSheet.boardType??"未登记"}</p>
      <p>品牌：{document.workbenchSheet.brand||"未登记"} · 参考款 / 版型：{document.workbenchSheet.referenceNote||"未登记"}</p>
      {document.workbenchSheet.sewingRows.length>0&&<table><thead><tr><th>颜色</th><th>尺码</th><th>制作件数</th></tr></thead><tbody>
        {document.workbenchSheet.sewingRows.map(row=><tr key={row.rowId}><td>{row.color||"未登记"}</td><td>{row.size||"未登记"}</td><td>{row.quantity??"未登记"}</td></tr>)}
      </tbody></table>}
    </section>}
    <div className="development-print-grid"><div>{document.files.filter(file=>file.kind==="款图"||file.kind==="局部图").map(file=><figure key={file.attachmentId}><img src={imageUrl(file.attachmentId)} alt={file.kind}/><figcaption>{file.kind}</figcaption></figure>)}<h4>制作说明</h4><p>{document.instructions||"—"}</p></div>
      <div><p>尺寸单位：{document.unit}</p>{groups.map(group=><table key={group.offset}><thead><tr><th>尺码</th>{group.sizes.map(size=><th key={size}>{size}</th>)}</tr></thead><tbody><tr><th>制作数量（件）</th>{group.sizes.map((size,index)=><td key={size}>{document.documentFormatVersion===2?(document.sizeQuantities?.[group.offset+index]??"未填"):"历史未分码"}</td>)}</tr>{document.measurements.map((row,index)=><tr key={index}><th>{row.name}</th>{row.values.slice(group.offset,group.offset+4).map((value,column)=><td key={column}>{value||"—"}</td>)}</tr>)}</tbody></table>)}<table><tbody>{Object.entries(details).map(([label,value])=><tr key={label}><th>{label}</th><td>{value||"—"}</td></tr>)}</tbody></table></div></div>
    <p>工艺：{document.craft} · 洗水：{washingChoiceLabel(document.washing)}</p>
    {document.materials.map(item=><section key={item.materialId}><h4>{item.label||item.category} · 使用范围以文员核料记录为准</h4><table><tbody>{Object.entries({"布行 / 供应商":item.supplier,"品名":item.name,"幅宽":item.width,"克重":item.weight,"成分":item.composition,"用量":item.consumption,"颜色":item.color,"规格":item.specification,"数量":item.quantity,...(document.workbenchSheet?{"款式颜色":item.garmentColor,"部位":item.part,"数量单位":item.quantityUnit}:{}),"发布时实物":item.available?"已有":"未到","原预计日期":item.expectedDate??"—"}).map(([label,value])=><tr key={label}><th>{label}</th><td>{value||"—"}</td></tr>)}</tbody></table>
      {item.sampleAttachmentId&&<p><a href={imageUrl(item.sampleAttachmentId)}>查看本版材料实样</a></p>}
      {sheet.materialEvents.filter(event=>event.materialId===item.materialId).map(event=><p key={event.eventId}>{event.action} · {event.expectedDate??""} · {event.note} · {new Date(event.createdAt).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai"})}</p>)}</section>)}
    {document.files.some(file=>file.kind==="菲林"||file.kind==="工艺开发板")&&<section><h4>随单附件（登录后查看原件）</h4>{document.files.filter(file=>file.kind==="菲林"||file.kind==="工艺开发板").map(file=><p key={file.attachmentId}><a href={imageUrl(file.attachmentId)}>{file.kind}</a></p>)}</section>}
  </article>;
}
