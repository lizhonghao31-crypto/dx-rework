import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Root single-user acceptance routing", () => {
  it("uses one Root-aware Todo projection across business services", async () => {
    const [server, projection] = await Promise.all([
      readFile("apps/api/src/server.ts", "utf8"),
      readFile("apps/api/src/todos/root-aware-projection-service.ts", "utf8"),
    ]);

    expect(server).toContain("const todoProjection = new RootAwareTodoProjectionService(todoService)");
    expect(server).not.toContain("rootAcceptanceReworkService");
    expect(projection).toContain('actor.actorRoles.includes("root_superuser")');
    expect(projection).toContain("actionableForUniqueDirectRole");
    expect(projection).toContain("actionableForUniqueRoleOrOrderDelegate");
  });

  it("keeps ordinary recipient-routing conflicts strict", async () => {
    const projection = await readFile(
      "apps/api/src/todos/root-aware-projection-service.ts",
      "utf8",
    );
    expect(projection).toContain("if (rootActor(args[1]) && isAcceptanceRoutingConflict(error)) return");
    expect(projection).toContain("throw error");
  });
});
