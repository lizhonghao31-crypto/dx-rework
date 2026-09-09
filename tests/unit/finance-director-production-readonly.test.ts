import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const read = (path: string) => readFile(path, "utf8");

describe("finance director production access", () => {
  it("allows the production reporting page and read endpoints", async () => {
    const [app, routes] = await Promise.all([
      read("apps/web/src/App.tsx"),
      read("apps/api/src/sourcing/production-reporting-routes.ts"),
    ]);

    const reportingGate = app.slice(
      app.indexOf('if (path.startsWith("/ui/production-reporting"))'),
      app.indexOf('if (path.startsWith("/ui/suppliers"))'),
    );
    expect(reportingGate).toContain('{ requiredRole: "finance_director", requiredCapability: "sourcing:view" }');
    expect(routes).toContain("const readActor=async(request:FastifyRequest)=>financeReadActor(await actor(request));");
    expect(routes).toContain("service.list(await readActor(request),query)");
    expect(routes).toContain("service.detail(await readActor(request),parse(Id,request.params.id))");
  });

  it("does not use the finance read actor for any production mutation", async () => {
    const routes = await read("apps/api/src/sourcing/production-reporting-routes.ts");
    expect(routes).toContain("service.report(await actor(request)");
    expect(routes).toContain("service.correct(await actor(request)");
    expect(routes).toContain("service.execute(await actor(request)");
    expect(routes).not.toContain("service.report(await readActor(request)");
    expect(routes).not.toContain("service.correct(await readActor(request)");
    expect(routes).not.toContain("service.execute(await readActor(request)");
  });
});
