import { BUDGET_SECTIONS, budgetDisplayAmount, calculateBudget, type BudgetSheet } from "@dx-rework/contracts/digital-budget";
import type { DigitalOrder } from "@dx-rework/contracts/digital-production";
import { createWebUrls } from "../url-contract.js";
import { budgetColumns as columns } from "./digital-budget-validation.js";
const urls=createWebUrls(import.meta.env.BASE_URL);
// Original paper structure bound only to the currently selected saved snapshot.
export function DigitalBudgetPrint({order,sheet,permitted,imageUrl}:{order:DigitalOrder;sheet:BudgetSheet|null;permitted:boolean;imageUrl?:((id:string)=>string)|undefined}){
 const doc=sheet?.document;
 if(!doc||!permitted)return <p className="budget-editor budget-print-only">当前单据不可打印，请先保存当前修改。</p>;
 const totals=calculateBudget(doc),amount=(value:string|null)=>value===null?"—":budgetDisplayAmount(value);
 const field=(key:"fabricType"|"productCategory"|"monthSeries"|"freight"|"cm"|"salePrice"|"outsourcingScope"|"outsourcingUnitPrice",label:string)=><label>{label}<span className="budget-print-value">{doc[key]?["freight","cm","salePrice","outsourcingUnitPrice"].includes(key)?budgetDisplayAmount(doc[key]):doc[key]:"—"}</span></label>;
 return <section className="budget-editor budget-print-only"><form><fieldset>
  <header><h2>广州市达兴制衣有限公司</h2><h3>成本预算表</h3></header>
  <div className="budget-heading"><span>产品性别：{order.productGroup}</span>{field("fabricType","面料属性")}{field("productCategory","产品类别")}<span>{order.productGroup}{doc.fabricType}{doc.productCategory}</span><span>设计师：{sheet.designerName}</span>{field("monthSeries","月份系列")}<span>设计款号：{order.designStyleNo}</span><span>客户：{order.customerCode}</span></div>
  <div className="budget-images">{doc.imageAttachmentIds.map(id=><div key={id}><img alt="预算款图" src={(imageUrl?imageUrl(id):urls.apiUrl(`digital-production/orders/${order.productionOrderId}/budget/attachments/${id}`))}/></div>)}</div>
  <table><thead><tr><th>款号</th><th>PO号</th><th>颜色</th><th>件数</th></tr></thead><tbody>{order.lines.map(line=><tr key={line.lineId}><td>{line.formalStyleNo||line.temporaryStyleNo||order.temporaryStyleNo||order.designStyleNo}</td><td>{line.poNumber||"—"}</td><td>{line.color}</td><td>{line.sizes.reduce((sum,size)=>sum+size.quantity,0).toLocaleString()}</td></tr>)}</tbody></table>
  {BUDGET_SECTIONS.map(section=><section key={section}><h4>{section}</h4><div className="budget-table-scroll"><table><thead><tr>{Object.values(columns).map(label=><th key={label}>{label}</th>)}<th>金额</th></tr></thead><tbody>{doc.rows.filter(row=>row.section===section).map(row=><tr key={row.rowId}>{(Object.keys(columns) as Array<keyof typeof columns>).map(key=><td key={key}><span className="budget-print-value">{key==="unitPrice"&&row[key]?budgetDisplayAmount(row[key]):row[key]}</span></td>)}<td>{amount(totals.rows.find(item=>item.rowId===row.rowId)!.amount)}</td></tr>)}</tbody><tfoot><tr><th colSpan={7}>{section}合计</th><td>{amount(totals[section==="主料"?"main":section==="辅料"?"accessories":"processes"])}</td></tr></tfoot></table></div></section>)}
  <div className="budget-summary">{field("freight","运费")}{field("cm","CM加工费用（裁、车、烫、包装）")}<p>成本合计（不含税）：{amount(totals.cost)}</p>{field("salePrice","销售单价（不含税，人民币）")}<p>利润：{amount(totals.profit)}</p>{field("outsourcingScope","本次实际外发范围")}{field("outsourcingUnitPrice","本次实际外发预算价")}</div>
  <footer><span>业务跟单：{sheet.merchandiserName||"待指派"}</span><label>日期<span className="budget-print-value">{doc.date||"—"}</span></label></footer>
 </fieldset></form></section>;
}
