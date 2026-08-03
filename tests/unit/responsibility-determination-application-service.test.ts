import type {
  CreateResponsibilityDraft,
  ResponsibilityDeterminationResponse,
} from "@dx-rework/contracts";
import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AuthorizedResponsibilityDeterminationService } from "../../apps/api/src/rework/responsibility-determination-authorized-service.js";
import { ResponsibilityDeterminationApplicationService } from "../../apps/api/src/rework/responsibility-determination-application-service.js";
import { ResponsibilityDeterminationService } from "../../apps/api/src/rework/responsibility-determination-service.js";
import type { TrustedActorContext } from "../../apps/api/src/tools/repositories.js";

const actor: TrustedActorContext = {
  actorId: "00000000-0000-4000-8000-000000000001",
  actorRoles: ["production_management"],
  authorizationCapability: "responsibility:determine",
  authorizationCapabilities: ["responsibility:determine"],
  requestId: "application-service-test",
};

const input: CreateResponsibilityDraft = {
  expectedOrderVersion: 7,
  expectedCurrentDeterminationVersion: null,
  handlerUserId: actor.actorId,
  processes: [
    {
      configurationItemId: "00000000-0000-4000-8000-000000000002",
      multiplier: "1.000",
      allocations: [
        { responsibilityType: "own_factory", shareBps: 10000 },
      ],
    },
  ],
};

const storedResponse: ResponsibilityDeterminationResponse = {
  reworkOrderId: "00000000-0000-4000-8000-000000000003",
  reworkStatus: "pending_responsibility_determination",
  orderVersion: 8,
  handlerUserId: actor.actorId,
  canDetermine: true,
  canTakeover: false,
  canConfirmHighMultiplier: false,
  sourceProcesses: [],
  determination: null,
};

describe("ResponsibilityDeterminationApplicationService", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns the idempotency repository response without re-reading mutable state", async () => {
    const storedResult = { value: storedResponse, reused: true };
    const saveDraft = vi
      .spyOn(ResponsibilityDeterminationService.prototype, "saveDraft")
      .mockResolvedValue(storedResult);
    const authorizedGet = vi.spyOn(
      AuthorizedResponsibilityDeterminationService.prototype,
      "get",
    );
    const service = new ResponsibilityDeterminationApplicationService(
      {} as Pool,
    );

    const result = await service.saveDraft(
      actor,
      storedResponse.reworkOrderId,
      input,
      "stable-draft-key",
    );

    expect(result).toBe(storedResult);
    expect(saveDraft).toHaveBeenCalledWith(
      actor,
      storedResponse.reworkOrderId,
      input,
      "stable-draft-key",
    );
    expect(authorizedGet).not.toHaveBeenCalled();
  });
});
