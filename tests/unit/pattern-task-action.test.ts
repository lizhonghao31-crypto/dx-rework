import {describe,expect,it} from "vitest";
import {patternTaskAction} from "../../apps/web/src/pattern-task-action.js";
describe("direct board task actions reflect current task and read state",()=>{
 it("names each role's actual action without a second entry shell",()=>{
  for(const [key,label] of Object.entries({development_materials:"核对面辅料",development_pattern:"做纸样",development_cutting:"做裁板",development_sewing:"做车缝",development_tail_check:"检查样板"}))expect(patternTaskAction({key,state:"active"})).toBe(label);
 });
 it("opens waiting, blocked and completed records without promising a write action",()=>{
  expect(patternTaskAction({key:"development_pattern",state:"pending"})).toBe("查看等待条件");
  expect(patternTaskAction({key:"development_pattern",state:"blocked"})).toBe("查看问题与恢复");
  expect(patternTaskAction({key:"development_pattern",state:"completed"})).toBe("查看办理记录");
 });
});
