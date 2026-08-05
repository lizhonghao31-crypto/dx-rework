import type { TrustedActorContext } from "../tools/repositories.js";

export const ERP_INTEGRATION_SERVICE_ACTOR_ID = "00000000-0000-4000-8000-000000000016";
export const ERP_INTEGRATION_SERVICE_ROLE = "integration_service";
export const ERP_INTEGRATION_CAPABILITY = "erp:integrate";

export const createErpIntegrationActor = (requestId: string): TrustedActorContext => ({
  actorId: ERP_INTEGRATION_SERVICE_ACTOR_ID,
  actorRoles: [ERP_INTEGRATION_SERVICE_ROLE],
  authorizationCapability: ERP_INTEGRATION_CAPABILITY,
  authorizationCapabilities: [ERP_INTEGRATION_CAPABILITY, "erp:result:read"],
  requestId,
});
