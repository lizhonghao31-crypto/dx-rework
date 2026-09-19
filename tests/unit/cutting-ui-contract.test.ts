import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import {
  cuttingListPath,
  cuttingReturnPath,
  readCuttingListQuery,
} from "../../apps/web/src/cutting-query.js";

describe("cutting UI contract", () => {
  it("keeps list state in the return path", () => {
    const path = cuttingListPath({
      q: "1234",
      status: "recorded",
      outOfRange: true,
      page: 3,
    });
    expect(path).toBe("/ui/cutting?q=1234&status=recorded&outOfRange=true&page=3");
    expect(readCuttingListQuery(path.slice(path.indexOf("?")))).toEqual({
      q: "1234",
      status: "recorded",
      outOfRange: true,
      page: 3,
    });
    expect(cuttingReturnPath(`?${new URLSearchParams({ returnTo: path })}`)).toBe(path);
    expect(cuttingReturnPath("?returnTo=https://example.com")).toBe("/ui/cutting");
  });

  it("places order cutting immediately after sourcing in desktop navigation", async () => {
    const source = await readFile(
      new URL("../../apps/web/src/components.tsx", import.meta.url),
      "utf8",
    );
    const sourcing = source.indexOf('{ name: "外发定价&选厂", description: "询价、审批与执行", entries: sourcingNavigation }');
    const cutting = source.indexOf('{ name: "订单开裁", description: "裁床实裁", entries: cuttingNavigation }');
    expect(sourcing).toBeGreaterThan(-1);
    expect(cutting).toBeGreaterThan(sourcing);
    expect(source.slice(sourcing, cutting)).not.toContain("供应商中心");
  });

  it("centers cutting pagination against the full list width on desktop and mobile", async () => {
    const css = await readFile(
      new URL("../../apps/web/src/cutting-page.css", import.meta.url),
      "utf8",
    );
    expect(css).toContain(".cutting-pagination{display:grid;grid-template-columns:1fr auto 1fr");
    expect(css).toContain(".cutting-pagination>.my-todos-pagination{grid-column:2;justify-self:center}");
    expect(css).toContain("@media(max-width:760px)");
    expect(css).toContain(".cutting-pagination{grid-template-columns:1fr;justify-items:center}");
    expect(css).toContain(".cutting-pagination>.my-todos-pagination{grid-column:1;justify-self:center}");
  });

  it("keeps mobile form controls readable and folds the low-frequency range filter", async () => {
    const [page, css] = await Promise.all([
      readFile(new URL("../../apps/web/src/cutting-page.tsx", import.meta.url), "utf8"),
      readFile(new URL("../../apps/web/src/cutting-page.css", import.meta.url), "utf8"),
    ]);
    expect(page).toContain('<details className="cutting-range-disclosure">');
    expect(page).toContain('inputMode="numeric"');
    expect(page).toContain("士啤片");
    expect(page).not.toContain("裁片数");
    expect(page).toContain("上传裁床单");
    expect(page).toContain("必须上传1张，最多3张；支持 JPEG / PNG / WebP。");
    expect(page).toContain('accept="image/*"');
    expect(page).toContain("prepareImageUploadCandidate");
    expect(page).toContain("uploadImageWithNormalizationRetry");
    expect(page).toContain('className="rework-v2-upload"');
    expect(page).toContain('className="rework-v2-image-grid"');
    expect(page).not.toMatch(/window\.(alert|prompt|confirm)\s*\(/);
    expect(page).toContain("const correctionAttempt = useRef");
    expect(page).toContain("correctionAttempt.current?.body !== body");
    expect(page).toContain('headers: { "idempotency-key": correctionAttempt.current.key }');
    expect(css).toContain("@media(max-width:760px)");
    expect(css).toContain(".cutting-count-control input{min-height:46px;font-size:16px}");
    expect(css).toContain(".cutting-record-actions{position:sticky");
    expect(css).toContain(".cutting-toolbar__range--desktop{display:none}");
  });
});
