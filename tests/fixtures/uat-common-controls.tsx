// Isolated TEST controls and existing queue component; never an application entry point.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { configureChineseValidation } from "../../packages/contracts/src/validation-language.js";
import { SearchableSelect, SearchSelect } from "../../apps/web/src/search-select.js";
import { installChineseNativeValidation } from "../../apps/web/src/native-validation.js";
import { WorkflowQueuePage } from "../../apps/web/src/reporting/workflow-queue-page.js";
import "../../packages/ui/src/tokens.css";
import "../../packages/ui/src/components.css";
import "../../apps/web/src/styles.css";
import "../../apps/web/src/workflow-shell.css";
import "../../apps/web/src/scoped-select-arrow.css";
configureChineseValidation();
installChineseNativeValidation(document);
function Controls() {
  const [value, setValue] = useState("");
  const [generic, setGeneric] = useState("");
  const [submits, setSubmits] = useState(0);
  const [needsReason, setNeedsReason] = useState(true);
  const [phaseSubmits, setPhaseSubmits] = useState(0);
  return <main className="app-shell" style={{ maxWidth: 500, padding: 16, boxSizing: "border-box" }}>
    <h1>TEST 原有约束与选择控件</h1><label>固定状态<select aria-label="固定状态"><option>待办理</option><option>已完成</option></select></label><select aria-label="多选原控件" multiple><option>甲</option><option>乙</option></select>
    <form onSubmit={event => { event.preventDefault(); setSubmits(n => n + 1); }}>
      <label htmlFor="factory">加工厂 *</label>
      <SearchableSelect id="factory" name="factory" required value={value} onChange={event => setValue(event.target.value)}>
        <option value="">请选择</option><option value="one">TEST 上海工厂</option><option value="two">TEST 广州工厂</option><option value="denied" disabled>TEST 禁用工厂</option>
      </SearchableSelect>
      <p data-testid="selected">{value || "未选择"}</p>
      <label htmlFor="quantity">数量 *</label><input style={{ width: "100%", boxSizing: "border-box" }} id="quantity" name="quantity" type="number" min="1" required />
      <details><summary>原有选填/条件约束</summary><label htmlFor="memo">备注（选填）</label><input id="memo" name="memo" /></details>
      <button type="submit">提交</button><button type="submit" formNoValidate>保存草稿</button>
      <output data-testid="submits">{submits}</output>
    </form>
    <label>已有人员<SearchSelect options={[{value:"a",label:"TEST 张三"},{value:"b",label:"TEST 李四"}]} value={generic} placeholder="输入姓名" ariaLabel="已有人员" onChange={setGeneric}/></label>
    <output data-testid="generic">{generic}</output>
    <SearchableSelect aria-label="已禁用选择" disabled><option>TEST 禁用</option></SearchableSelect>
    <form onSubmit={event => { event.preventDefault(); setPhaseSubmits(n => n + 1); }}>
      <label><input type="checkbox" checked={needsReason} onChange={event => setNeedsReason(event.target.checked)} />缺项退回</label>
      <label htmlFor="phase-reason">办理原因{needsReason ? " *" : "（选填）"}</label><textarea id="phase-reason" required={needsReason}/>
      <button type="submit">提交当前阶段</button><output data-testid="phase-submits">{phaseSubmits}</output>
    </form>
    <form><label htmlFor="business">业务自定义校验</label><input id="business" onChange={event => event.currentTarget.setCustomValidity("原有业务原因")} /></form>
  </main>;
}
const statuses = ["pending_process_configuration", "pending_ie_review"] as const;
createRoot(document.getElementById("root")!).render(new URLSearchParams(location.search).has("queue")
  ? <WorkflowQueuePage active="process" title="TEST 节点队列" statuses={statuses}/>
  : <Controls/>);
