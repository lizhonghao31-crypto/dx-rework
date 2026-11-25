import {DEVELOPMENT_MEASUREMENTS,developmentCraftOptions,developmentMakingSizes} from "@dx-rework/contracts/digital-development";
import type {DevelopmentDocument,DevelopmentSheet} from "@dx-rework/contracts/digital-development";
import type {Ref} from "react";
import {DevelopmentCustomerFeedbackPrint} from "./development-customer-feedback-print.js";
import {washingChoiceLabel} from "./digital-workspace-copy.js";
import "./digital-development-print.css";

const valueText=(value:string|null|undefined)=>value||"—";
const summaryText=(value:string|null|undefined)=>value&&(value.length>35||value.includes("\n"))?"见后附明细":valueText(value);
const materialFields=(item:DevelopmentDocument["materials"][number])=>({
  "布行 / 供应商":item.supplier,"品名":item.name,"幅宽":item.width,"克重":item.weight,"成分":item.composition,
  "用量":item.consumption,"颜色":item.color,"规格":item.specification,"数量":item.quantity,"数量单位":item.quantityUnit,
  "款式颜色":item.garmentColor,"部位":item.part,"发布时实物":item.available?"已有":"未到","原预计日期":item.expectedDate,
});
function PrintFields({fields,summary=false,className="development-paper-fields"}:{fields:Record<string,string|null|undefined>;summary?:boolean;className?:string}){
  return <dl className={className}>{Object.entries(fields).map(([label,value])=><div key={label}><dt>{label}</dt><dd>{summary?summaryText(value):valueText(value)}</dd></div>)}</dl>;
}
export function DevelopmentPrint({sheet,document,imageUrl,printRef}:{sheet:DevelopmentSheet;document:DevelopmentDocument;imageUrl:(id:string)=>string;printRef?:Ref<HTMLDivElement>|undefined}) {
  const garment=document.templateConfirmed?document.template:null;
  const roundNumber=sheet.roundNumber??1;
  const selectedRevision=sheet.status==="published"?sheet.printRevision:undefined;
  const feedback=sheet.status==="published"?sheet.printFeedback:undefined;
  const timing=sheet.status==="published"?sheet.printTiming:undefined;
  const round=selectedRevision?.revisionNumber? `复版${selectedRevision.revisionNumber} · 本单第${roundNumber}轮`:`本单第${roundNumber}轮`;
  const issued=sheet.numberedIdentity?.orderNumber;
  const identity={
    orderNumber:issued??sheet.designStyleNo??"",
    styleNo:issued&&issued===sheet.designStyleNo?"":sheet.designStyleNo,
    customer:sheet.customerCode??(document.customerOrderDraft?.order.customerCode||"通用开发"),
    designer:sheet.designerName,round,version:`v${sheet.version}`,
  };
  const dispatchBasis=timing?.dispatchedDocumentVersion===undefined||timing.dispatchedDocumentVersion===sheet.version?"":`（发板依据 v${timing.dispatchedDocumentVersion}）`;
  const pageIdentity=[identity.orderNumber||"待生成",identity.styleNo||"—",round,`资料版本 ${identity.version}`,sheet.status==="draft"?"草稿":""].filter(Boolean).join(" · ");
  const groups=Array.from({length:Math.max(1,Math.ceil(document.sizes.length/2))},(_,index)=>({offset:index*2,sizes:document.sizes.slice(index*2,index*2+2)}));
  const savedPictures=document.files.filter(file=>file.kind==="款图"||file.kind==="局部图");
  const coverPicture=savedPictures.find(file=>file.kind==="款图");
  const pictures=coverPicture?[coverPicture,...savedPictures.filter(file=>file!==coverPicture)]:savedPictures;
  const fabrics=document.materials.filter(item=>item.category!=="辅料");
  const auxiliaries=document.materials.filter(item=>item.category==="辅料");
  const actualMaterials=document.materials.filter(item=>item.requiredThisRound||item.available||item.auxiliaryCatalog||item.sampleAttachmentId
    ||[item.supplier,item.name,item.width,item.weight,item.composition,item.consumption,item.color,item.specification,item.quantity,item.quantityUnit,item.garmentColor,item.part,item.expectedDate].some(Boolean)
    ||sheet.materialEvents.some(event=>event.materialId===item.materialId));
  const materialSummary=[fabrics.find(row=>row.category==="主布"),...Array.from({length:2},(_,index)=>fabrics.filter(row=>row.category==="配布")[index])];
  const craftRequirements=new Map(document.craftRequirements?.map(row=>[row.stepKey,row]));
  const craftSteps=developmentCraftOptions(document).filter(step=>craftRequirements.has(step.key));
  const boards=document.files.filter(file=>file.kind==="工艺开发板");
  const boardNumbers=new Map(boards.map((file,index)=>[file.attachmentId,index+1]));
  const washDetails={"洗水":washingChoiceLabel(document.washing),...(document.washing!=="免洗"?{"洗水方法":document.washingMethod}:{}),
    "整烫":document.ironing,"包装":document.packaging,...(document.washingIroning?{"原洗水整烫说明":document.washingIroning}:{})};
  const detailGroups=[
    {title:"朴料 / 车缝",fields:{"朴号":document.interlining,"门筒朴":document.placketInterlining,"车缝线":document.sewingThread,"纽门线":document.buttonholeThread,"针距":document.stitchDensity}},
    {title:"洗水 / 整烫 / 包装",fields:washDetails},
    {title:"尺码标识",fields:{"正装尺码":document.formalSizes,"休闲尺码":document.casualSizes}},
    {title:"唛类",fields:{"主唛":document.mainLabel?"有":"无","主唛车法":document.mainLabelMethod,"码唛":document.sizeLabel?"有":"无","洗水唛":document.careLabel?"有":"无"}},
  ];
  // Use the original template only to bound the first sheet's layout, never
  // as a data source for an exact saved or historical sheet.
  const firstSizeRows=garment?DEVELOPMENT_MEASUREMENTS[garment].length:DEVELOPMENT_MEASUREMENTS.上衣.length;
  const sizeTable=(group:typeof groups[number],offset=0,end=document.measurements.length)=><table className="development-paper-sizes" data-print-table>
    <thead><tr><th scope="col">尺寸项目</th>{group.sizes.map((size,index)=><th scope="col" key={index}>{size||"—"}</th>)}</tr></thead>
    <tbody>{group.sizes.length>0&&offset===0&&<tr><th scope="row">制作数量（件）</th>{group.sizes.map((_,index)=><td key={index}>{document.documentFormatVersion===2?(document.sizeQuantities?.[group.offset+index]??"未填"):"历史未分码"}</td>)}</tr>}
    {document.measurements.slice(offset,end).map((row,index)=><tr key={offset+index}><th scope="row">{row.name}</th>{group.sizes.map((_,column)=><td key={column}>{row.values[group.offset+column]||"—"}</td>)}</tr>)}</tbody>
  </table>;
  const detailTable=(fields:Record<string,string|null|undefined>)=><table data-print-table><tbody>{Object.entries(fields).map(([label,value])=><tr key={label}><th scope="row">{label}</th><td>{valueText(value)}</td></tr>)}</tbody></table>;
  const garmentLayout=garment==="上衣"?"top":garment==="裤子"?"trousers":"original";
  return <div className="development-print" ref={printRef} data-print-identity={`${sheet.sourceId}:${roundNumber}:${sheet.version}:${sheet.status}`} data-print-page-identity={pageIdentity}>
    <article className="development-print-document development-board-document" aria-label="款式设计与制作说明单" data-print-document="版单" data-garment-layout={garmentLayout}>
      <div data-print-cover>
        <header className="development-paper-title"><strong>广州市达兴制衣有限公司</strong><h2>款式设计与制作说明单{garment&&<small>{garment}</small>}{sheet.status==="published"&&document.rush&&<small className="development-paper-rush">急单</small>}</h2></header>
        <PrintFields fields={{"订单ID":identity.orderNumber||"待生成","款号":identity.styleNo,"客户":identity.customer,"设计师":identity.designer,"版型（原系统）":document.workbenchSheet?.boardType,"原打板类型":sheet.developmentType}}/>
        <PrintFields className="development-paper-fields development-paper-dates" fields={{"来源":selectedRevision?[selectedRevision.motherOrderNumber,`原开发单第${selectedRevision.sourceRound}轮`,round].filter(Boolean).join(" · "):round,
          "版本 / 数量":`${identity.version} · ${document.quantity?.toLocaleString()??"—"} 件（${developmentMakingSizes(document)}）`,
          "预计样板完成":document.returnDate,"实际发板":timing?.dispatchedOn?`${timing.dispatchedOn}${dispatchBasis}`:null,"实际回版":timing?.returnedOn}}/>
      </div>
      <div className="development-paper-grid">
        <div className="development-paper-left">
          <h3 className="development-paper-bar">款式图</h3>
          <div className="development-paper-pictures">{pictures.length===0?<p>未登记款图</p>:pictures.slice(0,2).map(file=><figure key={file.attachmentId}><img src={imageUrl(file.attachmentId)} alt={file.kind}/><figcaption>{file.kind}</figcaption></figure>)}</div>
          <section className="development-paper-instructions"><h3>工艺及制作说明</h3><p>{summaryText(document.instructions)}</p><p>工艺：{document.craft}{feedback?" · 本轮原评语见配套《客户评语单》":""}</p></section>
        </div>
        <div className="development-paper-right">
          <h3 className="development-paper-bar">尺寸表（{document.unit}）</h3>
          {sizeTable(groups[0]!,0,firstSizeRows)}
          <div className="development-paper-requirements">{detailGroups.map(group=><section key={group.title}><h3>{group.title}</h3><PrintFields summary className="development-paper-inline-fields" fields={group.fields}/></section>)}</div>
        </div>
      </div>
      <section className="development-paper-materials">
        <h3 className="development-paper-bar">面辅料资料</h3>
        <div className="development-paper-material-summary">
          {materialSummary.map((item,index)=><section key={index}><h3>{summaryText(item?.label||["主布 A","配布 B","配布 C"][index])}</h3>
            <PrintFields summary className="development-paper-inline-fields" fields={{"布行":item?.supplier,"品名":item?.name,"幅宽":item?.width,"克重":item?.weight,"成分":item?.composition,"用量":item?.consumption}}/>
          </section>)}
          <section><h3>辅料</h3>{auxiliaries.slice(0,3).map(item=><p key={item.materialId}>{[summaryText(item.name),summaryText(item.specification),summaryText(item.consumption)].join(" / ")}</p>)}{auxiliaries.length>3&&<p>其余见后附明细</p>}</section>
        </div>
      </section>
      {pictures.slice(2).map(file=><figure key={file.attachmentId} className="development-paper-supplement-image"><img src={imageUrl(file.attachmentId)} alt={file.kind}/><figcaption>{file.kind}</figcaption></figure>)}
      {document.measurements.length>firstSizeRows&&<section data-print-split-table><h3 className="development-paper-bar">尺寸续表（{document.unit}）</h3>{sizeTable(groups[0]!,firstSizeRows)}</section>}
      {groups.slice(1).map(group=><section key={group.offset} data-print-split-table><h3 className="development-paper-bar">其它尺码（{document.unit}）</h3>{sizeTable(group)}</section>)}
      {summaryText(document.instructions)==="见后附明细"&&<section data-print-split-text><h3 className="development-paper-bar">制作说明原文</h3><p>{document.instructions}</p></section>}
      {detailGroups.flatMap(group=>Object.entries(group.fields)).filter(([,value])=>value&&summaryText(value)==="见后附明细")
        .map(([label,value])=><section key={label} data-print-split-text><h3 className="development-paper-bar">{label}</h3><p>{value}</p></section>)}
      {(document.workbenchSheet||sheet.temporaryStyleNo)&&<section data-print-split-table>
        <h3 className="development-paper-bar">版单补充资料</h3>{detailTable({"款名":document.workbenchSheet?.styleName,"性别":document.workbenchSheet?.gender,
          "品牌":document.workbenchSheet?.brand,"参考款 / 版型说明":document.workbenchSheet?.referenceNote,"代用号":sheet.temporaryStyleNo})}
      </section>}
      {document.workbenchSheet?.sewingRows.length? <section data-print-split-table><h3 className="development-paper-bar">颜色尺码与制作件数</h3>
        <table data-print-table><thead><tr><th>颜色</th><th>尺码</th><th>制作件数</th></tr></thead><tbody>{document.workbenchSheet.sewingRows.map(row=><tr key={row.rowId}><td>{row.color||"—"}</td><td>{row.size||"—"}</td><td>{row.quantity??"—"}</td></tr>)}</tbody></table>
      </section>:null}
      {craftSteps.map(step=>{
        const row=craftRequirements.get(step.key)!;
        return <section key={step.key} aria-label={step.label} data-print-split-table><h3 className="development-paper-bar">工艺要求 · {step.label}</h3>{detailTable({"部位":row.part,"规格 / 效果":row.specification,"制作说明":row.instructions})}</section>;
      })}
      {craftSteps.flatMap(step=>craftRequirements.get(step.key)!.attachmentIds.flatMap(id=>{
        const number=boardNumbers.get(id);
        return number===undefined?[]:[<figure key={`${step.key}:${id}`} className="development-paper-supplement-image" data-print-craft-image={id}><a href={imageUrl(id)}>{step.label} · 工艺开发板 {number}</a></figure>];
      }))}
      {actualMaterials.map(item=><section key={item.materialId} data-print-split-table>
        <h3 className="development-paper-bar">{item.label||item.category} · 使用范围以文员核料记录为准</h3>{detailTable(materialFields(item))}
        {item.sampleAttachmentId&&<p><a href={imageUrl(item.sampleAttachmentId)}>查看本版材料实样</a></p>}
        {sheet.materialEvents.filter(event=>event.materialId===item.materialId).map(event=><p key={event.eventId}>{event.action} · {event.expectedDate??""} · {event.note} · {new Date(event.createdAt).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai"})}</p>)}
      </section>)}
      {document.files.filter(file=>file.kind==="菲林"||file.kind==="工艺开发板").map(file=><p key={file.attachmentId}><a href={imageUrl(file.attachmentId)}>{file.kind}{boardNumbers.has(file.attachmentId)?` ${boardNumbers.get(file.attachmentId)}`:""}（登录后查看原件）</a></p>)}
    </article>
    {feedback&&<DevelopmentCustomerFeedbackPrint identity={identity} feedback={feedback}/>}
  </div>;
}
