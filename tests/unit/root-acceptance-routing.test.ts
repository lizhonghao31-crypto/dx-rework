import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Root single-user acceptance routing", () => {
  it("keeps Root N01 submission independent from todo recipient configuration", async () => {
    const [server, routes] = await Promise.all([
      readFile("apps/api/src/server.ts", "utf8"),
      readFile("apps/api/src/rework/routes.ts", "utf8"),
    ]);

    expect(server).toContain("const rootAcceptanceReworkService = new ReworkInitiationService(");
    expect(server).toContain("rootAcceptanceService: rootAcceptanceReworkService");
    expect(routes).toContain('accessActor.actorRoles.includes("root_superuser")');
    expect(routes).toContain("dependencies.rootAcceptanceService");
  });

  it("does not expose the internal todo routing error to business users", async () => {
    const routes = await readFile("apps/api/src/rework/routes.ts", "utf8");
    expect(routes).toContain("尾部主管接收人尚未唯一配置");
    expect(routes).toContain("translateTodoRoutingError");
  });
});
