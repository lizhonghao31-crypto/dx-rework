import { describe,it,expect } from "vitest";
import { readWageListQuery,wageListPath,wageReturnPath,wageSourcePath } from "../../apps/web/src/wages/wage-query-state.js";
import { patternReturnPath } from "../../apps/web/src/pattern-order-query.js";
const orderId="00000000-0000-4000-8000-000000000001",roundId="00000000-0000-4000-8000-000000000002",segmentId="00000000-0000-4000-8000-000000000003";
describe("wage source navigation",()=>{
  it("preserves the full filter and both page positions through original orders",()=>{
    const path=wageListPath({from:"2026-08-01",to:"2026-08-31",q:"同名 & 款号",personType:"temporary",wageSource:"pattern_room",patternKind:"misc",status:"settled",page:34,personPage:2,limit:500});
    expect(readWageListQuery(path.slice(path.indexOf("?")))).toMatchObject({q:"同名 & 款号",patternKind:"misc",page:34,personPage:2});
    expect(path).not.toContain("limit=");
    expect(patternReturnPath(`?${new URLSearchParams({returnTo:path})}`)).toBe(path);
    for(const wageKind of ["first_pattern","pattern_rework","misc"]){
      const target=wageSourcePath({sourceStatus:"available",wageSource:"pattern_room",sourceOrderId:orderId,roundId,segmentId,wageKind},path)!;
      const url=new URL(target,"https://example.test");
      expect(url.pathname).toBe(`/ui/pattern-room/orders/${orderId}`);
      expect(url.searchParams.get("round")).toBe(roundId);expect(url.searchParams.get("segment")).toBe(segmentId);
      expect(url.searchParams.get("returnTo")).toBe(path);expect(url.hash).toBe(`#segment-${segmentId}`);
    }
    expect(wageSourcePath({sourceStatus:"available",wageSource:"order_rework",sourceOrderId:orderId},path)).toContain(`/ui/tasks/${orderId}?`);
  });
  it("never guesses missing, removed or malformed sources from displayed numbers",()=>{
    for(const row of [{sourceStatus:"missing"},{sourceStatus:"unavailable"},{sourceStatus:"available",sourceOrderId:"RW-001"},{sourceStatus:"available",sourceOrderId:orderId,wageSource:"unknown"}])
      expect(wageSourcePath({...row,orderNo:orderId,styleNo:orderId},"/ui/wages")).toBeNull();
    expect(wageReturnPath("https://example.test/ui/wages")).toBeNull();
    expect(wageReturnPath("/ui/wages/../../../admin")).toBeNull();
  });
});
