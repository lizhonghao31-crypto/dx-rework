import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReworkNodeHistoryView } from "../../apps/web/src/rework-node-history-page.js";
import type { ReworkNodeHistory } from "@dx-rework/contracts/reporting";
import { wageBasis, wageBasisValue } from "../../apps/web/src/wages/wage-basis.js";
import { reworkHistorySource } from "../../apps/web/src/rework-return-path.js";

describe("saved wage basis and completed history return", () => {
  it("shows the stored multiplier for the 1001 example without deriving or rewriting its 12.01 wage", () => {
    const row={wageSource:"order_rework",wageKind:"inhouse_finishing",personType:"temporary",assignmentMode:"individual",quantity:"1001",unit:"piece",unitPrice:"0.010",temporaryWageMultiplier:"1.200",exactPersonShare:"12.01200000",wageAmount:"12.01"};
    const before=JSON.stringify(row);
    expect(wageBasis(row)).toContain("1,001 件 × 0.01 元/件 × 临时工系数 1.2");
    expect(wageBasisValue(row.exactPersonShare)).toBe("12.012");
    expect(JSON.stringify(row)).toBe(before);
    expect(wageBasis({...row,temporaryWageMultiplier:null})).toContain("临时工系数历史未记录");
    expect(wageBasis({...row,personType:"internal",quantity:"1000",wageAmount:"10.00"})).toBe("1,000 件 × 0.01 元/件；工资以已保存金额为准");
  });
  it("keeps exact stored shares, collective and board/misc bases distinct", () => {
    expect(wageBasisValue("0.01234567")).toBe("0.01234567");
    expect(wageBasis({wageSource:"order_rework",assignmentMode:"collective",groupAmount:"30.01000000",memberCount:3,exactPersonShare:"10.00333333"})).toContain("组总额 30.01 元，3 人；个人份额 10.00333333 元");
    const collective={wageSource:"order_rework",assignmentMode:"collective",personType:"temporary",groupAmount:"30.01000000",memberCount:3,exactPersonShare:"10.00333333",wageAmount:"10.00"};
    expect(wageBasis({...collective,temporaryWageMultiplier:null})).toContain("临时工系数历史未记录");
    expect(wageBasis({...collective,temporaryWageMultiplier:"1.200"})).toContain("临时工系数 1.2");
    expect(wageBasis({wageSource:"pattern_room",wageKind:"misc",actualHours:"1.250",unitPrice:"12.345"})).toBe("1.25 小时 × 12.345 元/小时");
    expect(wageBasis({wageSource:"pattern_room",wageKind:"pattern_rework",sourceAmount:"12.123",roundAmount:"36.369"})).toBe("本段 12.123 元 / 整轮 36.369 元");
  });
  it("preserves wage filters and both page positions and rejects external or malformed wage returns", () => {
    const path="/ui/wages?from=2026-10-01&to=2026-10-19&q=TEST&page=34&personPage=2";
    expect(reworkHistorySource(`?${new URLSearchParams({returnTo:path})}`)).toEqual({path,label:"返回工资管理"});
    for(const bad of ["https://example.test/ui/wages","/ui/wages/../../../admin","/ui/wages\\x"])
      expect(reworkHistorySource(`?${new URLSearchParams({returnTo:bad})}`)).toEqual({path:"/ui/tasks",label:"返回订单列表"});
    expect(reworkHistorySource("?returnTo=%2Fui%2Fwages&returnTo=%2Fui%2Fwages%3Fpage%3D2")).toEqual({path:"/ui/tasks",label:"返回订单列表"});
  });
  it("offers no current-node loop after finishing completion and keeps a valid current link while work remains", () => {
    const data:ReworkNodeHistory={currentStatus:"completed",reworkKind:"inhouse_finishing",orderId:"00000000-0000-4000-8000-000000000001",node:"initiation",entry:{id:"00000000-0000-4000-8000-000000000002",label:"发起本厂做尾",at:"2026-10-01T00:00:00.000Z",actor:"TEST"},versions:[],fields:[{label:"款号",value:"TEST"}],sections:[],attachments:[],notices:[],inspectionReport:null};
    const html=(status:ReworkNodeHistory["currentStatus"],kind:ReworkNodeHistory["reworkKind"]="inhouse_finishing")=>renderToStaticMarkup(createElement(ReworkNodeHistoryView,{data:{...data,currentStatus:status,reworkKind:kind},currentHref:"/ui/tasks/00000000-0000-4000-8000-000000000001",onVersion:()=>{},onImage:()=>{}}));
    expect(html("completed")).not.toContain("返回当前节点");
    expect(html("completed")).toContain("本单已完成，当前为历史资料");
    expect(html("pending_final_quantity_ie_review")).toContain("返回当前节点");
    expect(html("completed","qc_rework")).toContain("查看业务完成资料");
  });
});
