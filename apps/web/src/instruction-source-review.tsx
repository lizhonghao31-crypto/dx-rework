import {useState} from "react";
import {Button} from "@dx-rework/ui";
import {instructionSourceLabels,type InstructionDocument,type InstructionSheet,type InstructionSourceGroup,type InstructionSourceReview} from "@dx-rework/contracts/production-instruction";
function Preview({document:doc,group,imageUrl}:{document:InstructionDocument;group:InstructionSourceGroup;imageUrl:(id:string)=>string}){
 if(group==="craft")return <p>{doc.secondaryCraft} · {doc.process||"无工艺说明"}</p>;
 if(group==="comments"||group==="composition")return <p className="instruction-source-text">{doc[group]||"空"}</p>;
 if(group==="images")return <div className="instruction-source-images">{doc.images.map(image=><figure key={image.attachmentId}><a href={imageUrl(image.attachmentId)} target="_blank" rel="noreferrer"><img src={imageUrl(image.attachmentId)} alt={image.kind}/></a><figcaption>{image.kind} {image.description}</figcaption></figure>)}{!doc.images.length&&<p>无附图</p>}</div>;
 if(group==="measurements")return <><p>单位：{doc.unit==="inch"?"英寸":"厘米"} · 尺码：{doc.sizes.join("、")||"无"}</p>{doc.measurements.map(row=><p key={row.id}>{row.name}：{row.values.map((value,index)=>`${doc.sizes[index]??""} ${value||"空"}`).join("；")} {row.tolerance} {row.method}</p>)}</>;
 if(group==="fabrics")return <>{doc.fabrics.map(row=><p key={row.id}>{row.name} · {row.part} · {[...new Set(Object.values(row.colors))].join("、")} · {row.remarks}</p>)}{!doc.fabrics.length&&<p>无面料</p>}</>;
 return <>{doc.accessories.map(row=><p key={row.id}>{row.group} · {row.name} · {row.part} · {row.specification} · {row.materialColor} · {row.consumption} · {row.remarks}</p>)}{!doc.accessories.length&&<p>无辅料</p>}</>;
}
export function InstructionSourceReviewPanel({sheet,document,busy,imageUrl,onReview,onClose}:{sheet:InstructionSheet;document:InstructionDocument;busy:boolean;imageUrl:(id:string)=>string;onReview:(decisions:InstructionSourceReview["decisions"])=>void;onClose:()=>void}){
 const [choices,setChoices]=useState<Partial<Record<InstructionSourceGroup,"adopt"|"retain">>>({});
 const [seen,setSeen]=useState<Partial<Record<InstructionSourceGroup,boolean>>>({});
 const comparison=sheet.sourceComparison;if(!comparison)return null;
 const complete=comparison.groups.every(group=>choices[group]);
 return <section className="instruction-source-review" aria-label="核对开发资料"><h3>核对开发第 {comparison.sourceRound} 轮资料</h3><p>只列出开发来源发生变化的技术组。采用会更新所选组；保留会留下本单现有值及差异记录。采用附图会追加新图，原附图继续保留。其余制单内容保持当前填写。</p>
  {comparison.groups.map(group=><details key={group} onToggle={event=>{if(event.currentTarget.open)setSeen(current=>({...current,[group]:true}));}}><summary>{instructionSourceLabels[group]}发生变化</summary>{seen[group]&&<div className="instruction-source-comparison">{([{title:"原采用开发资料",document:comparison.before},{title:"本单当前填写",document},{title:"新开发资料",document:comparison.proposed}]).map(value=><div key={value.title}><h4>{value.title}</h4><Preview document={value.document} group={group} imageUrl={imageUrl}/></div>)}</div>}</details>)}
  {comparison.groups.map(group=><label key={group}>{instructionSourceLabels[group]}核对结果<select aria-label={`${instructionSourceLabels[group]}核对结果`} disabled={busy||!seen[group]} value={choices[group]??""} onChange={event=>setChoices(current=>({...current,[group]:event.target.value as "adopt"|"retain"}))}><option value="">{seen[group]?"请选择":"先展开资料核对"}</option><option value="adopt">采用新开发值</option><option value="retain">保留本单原值</option></select></label>)}
  {!comparison.groups.length&&<p>本次开发轮次的制单技术资料没有变化。确认核对后只更新采用记录。</p>}
  <Button type="button" disabled={busy||!complete} onClick={()=>onReview(comparison.groups.map(group=>({group,action:choices[group]!})))}>确认核对并保存</Button><Button type="button" disabled={busy} onClick={onClose}>稍后核对</Button>
 </section>;
}
