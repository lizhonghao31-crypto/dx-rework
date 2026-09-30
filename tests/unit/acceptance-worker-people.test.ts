import { describe, expect, it, vi } from "vitest";
import { ensureAcceptanceWorkerPerson } from "../../scripts/acceptance/worker-people.js";
import type { TrustedActorContext } from "../../apps/api/src/tools/repositories.js";
const actor: TrustedActorContext = { actorId: "root", actorRoles: ["root_superuser"], authorizationCapability: "access:admin", requestId: "test" };
const worker = { alias: "pattern-room-worker", userId: "uat-worker", displayName: "[UAT] 板房师傅", roleCode: "pattern_room_worker" };
describe("Acceptance worker personnel repair", () => {
  it("repairs missing personnel for an already-authorized worker and is idempotent", async () => {
    const rows: { person_type: string; active: boolean }[] = [];
    const database = { query: vi.fn().mockImplementation(async () => ({ rows })) };
    const access = { createPerson: vi.fn().mockImplementation(async () => { rows.push({ person_type: "internal", active: true }); return { personId: "person" }; }) };
    await ensureAcceptanceWorkerPerson(database, access, actor, worker);
    await ensureAcceptanceWorkerPerson(database, access, actor, worker);
    expect(access.createPerson).toHaveBeenCalledTimes(1);
    expect(access.createPerson).toHaveBeenCalledWith(expect.objectContaining({ authorizationCapability: "master_data:manage" }), expect.objectContaining({ personType: "internal", appUserId: worker.userId }));
  });
  it("does not change inactive personnel or unrelated users", async () => {
    const database = { query: vi.fn().mockResolvedValue({ rows: [{ person_type: "internal", active: false }] }) };
    const access = { createPerson: vi.fn() };
    await expect(ensureAcceptanceWorkerPerson(database, access, actor, worker)).rejects.toThrow("conflicting");
    await expect(ensureAcceptanceWorkerPerson(database, access, actor, { ...worker, alias: "someone-else" })).rejects.toThrow("standard");
    await ensureAcceptanceWorkerPerson(database, access, actor, { ...worker, roleCode: "sample_designer" });
    expect(access.createPerson).not.toHaveBeenCalled();
    expect(database.query).toHaveBeenCalledTimes(1);
  });
});
