import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("order board global style search", () => {
  it("keeps date KPIs range-scoped while making non-empty style search all-time", async () => {
    const [service, routes] = await Promise.all([
      readFile("apps/api/src/receiving/receiving-service.ts", "utf8"),
      readFile("apps/api/src/receiving/receiving-routes.ts", "utf8"),
    ]);

    expect(service).toContain("const mode = needle ? \"search\" : \"range\"");
    expect(service).toContain("$3::text<>''");
    expect(service).toContain("upper(btrim(batch.style_no)) LIKE '%' || $3 || '%'");
    expect(service).toContain("receipt.received_at>=($1::date::timestamp AT TIME ZONE 'Asia/Shanghai')");
    expect(service).toContain("receipt.received_at<(($2::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai')");
    expect(routes).toContain("status?: string;");
    expect(routes).toContain("request.query.status ?? \"all\"");
  });
});
