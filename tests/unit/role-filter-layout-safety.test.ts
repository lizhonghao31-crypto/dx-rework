import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (path: string): string => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const safety = source("apps/web/src/role-layout-safety.css");
const board = source("apps/web/src/order-board-page.tsx");

// Structural guards complement the browser hit-testing evidence. They do not
// replace role-authenticated end-to-end or native date-picker acceptance.
describe("role-conditioned filter layout safety", () => {
  it("loads the narrowly scoped correction without global control overrides", () => {
    expect(source("apps/web/src/ui-polish.css")).toContain('@import "./role-layout-safety.css";');
    expect(safety).not.toMatch(/!important|z-index|pointer-events|position:\s*(?:absolute|fixed)/);
    expect(safety).not.toMatch(/(?:^|\n)(?:input|select|button|\.dx-button)\s*\{/);
  });

  it("flows optional export controls without assigning the first date to a 44px track", () => {
    expect(board).toContain("{canExport ? <button");
    expect(safety).toMatch(/\.ui-polish \.order-board-filters\s*\{[^}]*display:\s*flex;[^}]*flex-wrap:\s*wrap;/s);
    expect(safety).toMatch(/\.ui-polish \.order-board-filters > label\s*\{[^}]*flex:\s*1 1 140px;[^}]*min-width:\s*0;/s);
    expect(safety).toMatch(/\.ui-polish \.order-board-filters > \.order-board-export-button\s*\{[^}]*flex:\s*0 0 44px;/s);
    expect(safety).not.toMatch(/grid-template-columns:\s*44px/);
  });

  it("preserves independent native date state, bounds and API parameters", () => {
    expect(board).toContain('type="date" value={startDate} max={endDate}');
    expect(board).toContain('type="date" value={endDate} min={startDate}');
    expect(board).toContain("setStartDate(event.target.value)");
    expect(board).toContain("setEndDate(event.target.value)");
    expect(board).toContain("useReceivingBoardRead(targetBatchId,invalidTarget)");
    expect(source("apps/web/src/receiving-board-read.ts")).toContain("new URLSearchParams({ startDate, endDate })");
  });

  it("sizes nested controls within the available content width", () => {
    expect(safety).toMatch(/\.ui-polish \.order-board-filters select\s*\{[^}]*box-sizing:\s*border-box;[^}]*min-width:\s*0;/s);
    expect(safety).toMatch(/\.ui-polish \.reporting-filters \.dx-field__control input\s*\{[^}]*padding:\s*0;[^}]*border:\s*0;/s);
    expect(safety).toContain("grid-template-columns: repeat(auto-fit, minmax(140px, 1fr))");
    expect(safety).toMatch(/\.ui-polish \.reporting-filters--orders > \.reporting-date-range\s*\{[^}]*grid-column:\s*span 2;/s);
  });

  it("keeps the existing phone grid and leaves empty action containers out of layout", () => {
    expect(safety).toContain("@media (min-width: 561px)");
    expect(source("apps/web/src/reporting/rework-query-mobile.css")).toContain("grid-template-columns:repeat(3,minmax(0,1fr))");
    expect(safety).toMatch(/\.ui-polish \.order-board-heading__action:empty\s*\{[^}]*display:\s*none;/s);
    expect(safety).toContain("flex-basis: calc(50% - 5px)");
  });
});
