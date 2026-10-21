import { FactoryReceiptSelector } from "../../apps/web/src/production-closure-ui.js";
import type { ProductionReceivingSummary } from "@dx-rework/contracts";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { SearchableSelect, SearchSelect } from "../../apps/web/src/search-select.js";
import "../../packages/ui/src/tokens.css";
import "../../apps/web/src/styles.css";
function Fixture() {
  const [value, setValue] = useState(""), [changes, setChanges] = useState(0), [result, setResult] = useState(""), [disabled, setDisabled] = useState(false), [restricted, setRestricted] = useState(false);
  return <main style={{ maxWidth: 500, padding: 16, overflowWrap: "anywhere" }}><form onSubmit={event => { event.preventDefault(); setResult(JSON.stringify(Object.fromEntries(new FormData(event.currentTarget)))); }}>
    <fieldset disabled={disabled} style={{ minWidth: 0 }}><label>加工厂<SearchableSelect name="supplierId" required value={value} onChange={event => { setValue(event.target.value); setChanges(changes + 1); }}><option value="">请选择加工厂</option>{Array.from({length: 30}, (_, index) => <option key={index} value={`factory-${index}`} disabled={index === 2 || restricted && index === 25}>{index === 25 ? "达兴 Factory 25 很长的合法加工厂名称" : `加工厂 ${index}`}</option>)}</SearchableSelect></label>
    <label>主办<SearchableSelect name="personId" required defaultValue="p1"><option value="">请选择</option><option value="p1">张三</option><option disabled value="p2">已停用人员</option><option value="p3">李四</option></SearchableSelect></label>
    <button type="submit">保存</button></fieldset></form>
    <button onClick={() => setDisabled(!disabled)}>切换禁用</button><button onClick={() => setRestricted(true)}>收窄候选</button><button onClick={() => setValue("factory-3")}>外部修改</button>
    <output id="changes">{changes}</output><output id="result">{result}</output>
    <label>原有搜索<SearchSelect ariaLabel="原有搜索" value="" options={[{value:"old",label:"原有合法候选"}]} placeholder="原有搜索" onChange={() => undefined}/></label>
  </main>;
}
function ReceiptFixture() {
 const [shipment,setShipment]=useState<ProductionReceivingSummary|null>(null);
 return <main><FactoryReceiptSelector cuttingOrderId="00000000-0000-4000-8000-000000000099" shipment={shipment} onSelect={setShipment}/><output id="shipment">{shipment?.supplierName??""}</output></main>;
}
function FloatingFixture() {
  const [values, setValues] = useState<Record<string, string>>({}), [result, setResult] = useState(""), [disabled, setDisabled] = useState(false);
  return <main style={{ padding: 16, maxWidth: 900 }}>
    <p>合成总委派：原生候选不变，仅浮层脱离裁切</p>
    <form onSubmit={event => { event.preventDefault(); setResult(JSON.stringify(Object.fromEntries(new FormData(event.currentTarget)))); }}>
      <fieldset disabled={disabled} style={{ minWidth: 0, padding: 0, border: 0 }}>
        <div id="table-scroll" style={{ overflow: "auto", height: 250 }}>
          <table style={{ minWidth: 320, width: "100%" }}><tbody>{["纸样", "裁板", "车板", "尾部"].map(stage => <tr key={stage} style={{ height: 60 }}><th style={{ width: 70 }}>{stage}</th><td>
            <SearchableSelect menuPortal aria-label={`${stage}师傅`} name={stage} value={values[stage] ?? ""} onChange={event => setValues(previous => ({ ...previous, [stage]: event.target.value }))}>
              <option value="">尚未安排</option>{Array.from({ length: 35 }, (_, index) => <option key={index} value={`person-${index}`} disabled={index === 2}>{index === 2 ? "已停用师傅" : `合成师傅${index}`}</option>)}
            </SearchableSelect>
          </td></tr>)}</tbody></table>
          <div style={{ height: 280 }}>表内滚动区域</div>
        </div>
        <button type="submit">保存测试选择</button>
      </fieldset>
    </form>
    <button onClick={() => setDisabled(!disabled)}>切换整表禁用</button><button id="outside">表外按钮</button>
    <output id="result">{result}</output><div style={{ height: 900 }}>页面滚动区域</div>
  </main>;
}
createRoot(document.getElementById("root")!).render(window.location.search.includes("receipt")?<ReceiptFixture/>:window.location.search.includes("floating")?<FloatingFixture/>:<Fixture/>);
