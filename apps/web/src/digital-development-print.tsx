import {DEVELOPMENT_MEASUREMENTS,developmentCraftOptions,developmentMakingSizes} from "@dx-rework/contracts/digital-development";
import type {DevelopmentDocument,DevelopmentSheet} from "@dx-rework/contracts/digital-development";
import type {Ref} from "react";
import {DevelopmentCustomerFeedbackPrint} from "./development-customer-feedback-print.js";
import {washingChoiceLabel} from "./digital-workspace-copy.js";
import "./digital-development-print.css";

const valueText=(value:string|null|undefined)=>value||"—";
const summaryText=(value:string|null|undefined,limit=21)=>{
  if(!value)return valueText(value);
  const original=Array.from(value.replace(/\s+/g,' ').trim());
  return original.length>limit?`${original.slice(0,limit).join('')}…`:original.join('');
};
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
  const sizes=document.sizes.slice(0,4);
  const savedPictures=document.files.filter(file=>file.kind==="款图"||file.kind==="局部图");
  const coverPicture=savedPictures.find(file=>file.kind==="款图");
  const pictures=coverPicture?[coverPicture,...savedPictures.filter(file=>file!==coverPicture)]:savedPictures;
  const fabrics=document.materials.filter(item=>item.category!=="辅料");
  const auxiliaries=document.materials.filter(item=>item.category==="辅料");
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
  const sizeTable=<table className="development-paper-sizes" data-print-table>
    <thead><tr><th scope="col">尺寸项目</th>{sizes.map((size,index)=><th scope="col" key={index}>{summaryText(size,12)}</th>)}</tr></thead>
    <tbody>{sizes.length>0&&<tr><th scope="row">制作数量（件）</th>{sizes.map((_,index)=><td key={index}>{document.documentFormatVersion===2?(document.sizeQuantities?.[index]??"未填"):"历史未分码"}</td>)}</tr>}
    {document.measurements.slice(0,firstSizeRows).map((row,index)=><tr key={index}><th scope="row">{summaryText(row.name,29)}</th>{sizes.map((_,column)=><td key={column}>{summaryText(row.values[column],11)}</td>)}</tr>)}</tbody>
  </table>;
  const sewingRows=document.workbenchSheet?.sewingRows??[];
  const sewingSummary=sewingRows.slice(0,3).map(row=>[row.color,row.size,typeof row.quantity==='number'?`${row.quantity}件`:null].filter(Boolean).join(' / ')).filter(Boolean).join(' · ');
  const displayedCrafts=craftSteps.slice(0,2),shownCraftIds=new Set(displayedCrafts.flatMap(step=>(craftRequirements.get(step.key)?.attachmentIds??[]).filter(id=>boardNumbers.has(id)).slice(0,1)));
  const otherCraftFiles=document.files.filter(file=>(file.kind==='菲林'||file.kind==='工艺开发板')&&!shownCraftIds.has(file.attachmentId));
  const garmentLayout=garment==="上衣"?"top":garment==="裤子"?"trousers":"original";
  return <div className="development-print" ref={printRef} data-print-identity={`${sheet.sourceId}:${roundNumber}:${sheet.version}:${sheet.status}`} data-print-page-identity={pageIdentity}>
    <article className="development-print-document development-board-document" aria-label="款式设计与制作说明单" data-print-document="版单" data-print-single-page="true" data-garment-layout={garmentLayout}>
      <div data-print-cover>
        <header className="development-paper-title"><strong>广州市达兴制衣有限公司</strong><h2>款式设计与制作说明单{garment&&<small>{garment}</small>}{sheet.status==="published"&&document.rush&&<small className="development-paper-rush">急单</small>}</h2></header>
        <PrintFields className="development-paper-fields development-paper-basics" fields={{"款式（品名）":summaryText(document.workbenchSheet?.styleName,52),"品牌":summaryText(sheet.workbenchBasics?.brand??document.workbenchSheet?.brand,28)}}/>
        <PrintFields fields={{"订单ID":identity.orderNumber||"待生成","款号":identity.styleNo,"客户":summaryText(identity.customer),"设计师":summaryText(identity.designer),"版型（原系统）":document.workbenchSheet?.boardType,"原打板类型":sheet.developmentType}}/>
        <PrintFields className="development-paper-fields development-paper-dates" fields={{"来源":selectedRevision?[selectedRevision.motherOrderNumber,`原开发单第${selectedRevision.sourceRound}轮`,round].filter(Boolean).join(" · "):round,
          "版本 / 数量":`${identity.version} · ${document.quantity?.toLocaleString()??"—"} 件（${summaryText(developmentMakingSizes(document),46)}）`,
          "预计样板完成":document.returnDate,"实际发板":timing?.dispatchedOn?`${timing.dispatchedOn}${dispatchBasis}`:null,"实际回版":timing?.returnedOn}}/>
      </div>
      <div className="development-paper-grid">
        <div className="development-paper-left">
          <h3 className="development-paper-bar">款式图</h3>
          <div className="development-paper-pictures">{pictures.length===0?<p>未登记款图</p>:pictures.slice(0,2).map(file=><figure key={file.attachmentId}><img src={imageUrl(file.attachmentId)} alt={file.kind}/><figcaption>{file.kind}</figcaption></figure>)}</div>
          <section className="development-paper-instructions"><h3>工艺及制作说明</h3><p>{summaryText(document.instructions,72)}</p><p>工艺：{summaryText(document.craft,33)}{feedback?" · 本轮原评语见配套《客户评语单》":""}</p>
            {displayedCrafts.map(step=>{
              const row=craftRequirements.get(step.key)!;
              return <section key={step.key} aria-label={step.label} className="development-paper-craft-summary"><strong>工艺要求 · {summaryText(step.label,15)}</strong>
                <PrintFields summary className="development-paper-inline-fields" fields={{"部位":row.part,"规格 / 效果":row.specification,"制作说明":row.instructions}}/>
                {row.attachmentIds.filter(id=>boardNumbers.has(id)).slice(0,1).map(id=><figure key={id} data-print-craft-image={id}><a href={imageUrl(id)}>{step.label} · 工艺开发板 {boardNumbers.get(id)}</a></figure>)}
              </section>;
            })}
            {otherCraftFiles.slice(0,displayedCrafts.length?0:2).map(file=><p key={file.attachmentId}><a href={imageUrl(file.attachmentId)}>{file.kind}{boardNumbers.has(file.attachmentId)?` ${boardNumbers.get(file.attachmentId)}`:""}（登录后查看原件）</a></p>)}
          </section>
        </div>
        <div className="development-paper-right">
          <h3 className="development-paper-bar">尺寸表（{document.unit}）</h3>
          {sizeTable}
          {sewingSummary&&<p className="development-paper-sewing">颜色 / 尺码 / 制作件数 · {summaryText(sewingSummary,65)}</p>}
          <div className="development-paper-requirements">{detailGroups.map(group=><section key={group.title}><h3>{group.title}</h3><PrintFields summary className="development-paper-inline-fields" fields={group.fields}/></section>)}</div>
        </div>
      </div>
      <section className="development-paper-materials">
        <h3 className="development-paper-bar">面辅料资料</h3>
        <div className="development-paper-material-summary">
          {materialSummary.map((item,index)=><section key={index}><h3>{summaryText(item?.label||["主布 A","配布 B","配布 C"][index])}</h3>
            <PrintFields summary className="development-paper-inline-fields" fields={{"布行":item?.supplier,"品名":item?.name,"幅宽":item?.width,"克重":item?.weight,"成分":item?.composition,"用量":item?.consumption}}/>
          </section>)}
          <section><h3>辅料</h3>{auxiliaries.slice(0,3).map(item=><p key={item.materialId}>{[summaryText(item.name),summaryText(item.specification),summaryText(item.consumption)].join(" / ")}</p>)}</section>
        </div>
      </section>
      <p className="development-paper-online">此页为版单摘要。完整尺码、工艺、用料与原附件请查阅本版本在线资料。</p>
    </article>
    {feedback&&<DevelopmentCustomerFeedbackPrint identity={identity} feedback={feedback} imageUrl={imageUrl}/>}
  </div>;
}
