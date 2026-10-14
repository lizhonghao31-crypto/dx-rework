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
createRoot(document.getElementById("root")!).render(<Fixture/>);
