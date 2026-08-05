import { randomUUID } from "node:crypto";

import { loadConfig } from "@dx-rework/config";
import { DisabledErpAdapter, MockErpAdapter } from "@dx-rework/domain";
import { describe, expect, it, vi } from "vitest";

import { buildApp } from "../../apps/api/src/app.js";
import {
  ERP_INTEGRATION_CAPABILITY,
  ERP_INTEGRATION_SERVICE_ACTOR_ID,
  ERP_INTEGRATION_SERVICE_ROLE,
} from "../../apps/api/src/erp/erp-integration-identity.js";
import type { ErpIntegrationService } from "../../apps/api/src/erp/erp-integration-service.js";
import type { ReworkInitiationService } from "../../apps/api/src/rework/service.js";

const config = loadConfig({
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://test:test@localhost/test",
  DINGTALK_CORP_ID: "corp",
  DINGTALK_H5_APP_KEY: "key",
  DINGTALK_H5_APP_SECRET: "secret",
  DINGTALK_WEB_CLIENT_ID: "web",
  DINGTALK_WEB_CLIENT_SECRET: "secret",
  DINGTALK_QR_REDIRECT_URI: "https://example.test/callback",
  SESSION_SECRET: "a-test-session-secret-with-at-least-32-characters",
});

const payload = {
  contractVersion: "1",
  source: {
    sourceSystem: "erp",
    externalId: "ERP-RW-1",
    externalIdempotencyKey: "erp-rw-1",
    erpNodeId: "ERP-NODE-1",
  },
  payload: {
    styleNo: "ST-1",
    orderNo: "SO-1",
    merchandiserUserId: randomUUID(),
    processingFactory: { type: "own_factory" },
    problemPart: "后中",
    problemDescription: "线迹不良",
    reworkQuantity: 10,
  },
};

const intakeResponse = {
  contractVersion: "1",
  reworkOrderId: randomUUID(),
  reworkNo: "RW-20260806-001",
  status: "pending_process_configuration",
  intakeMode: "erp",
  linkageStatus: "linked",
  source: payload.source,
  createdAt: "2026-08-06T00:00:00.000Z",
};

const integrationActor = {
  actorId: ERP_INTEGRATION_SERVICE_ACTOR_ID,
  actorRoles: [ERP_INTEGRATION_SERVICE_ROLE],
  authorizationCapability: ERP_INTEGRATION_CAPABILITY,
  requestId: "request",
};

const rework = {} as ReworkInitiationService;

function appFor(input: {
  adapter: DisabledErpAdapter | MockErpAdapter;
  capabilities?: string[];
  roles?: string[];
  integrationAuth?: boolean;
}) {
  const service = {
    intakeFromErp: vi.fn().mockResolvedValue({ value: intakeResponse, reused: false }),
    emergencyIntake: vi.fn().mockResolvedValue({
      value: { ...intakeResponse, intakeMode: "emergency", linkageStatus: "pending" },
      reused: false,
    }),
    linkEmergency: vi.fn(),
    result: vi.fn(),
  };
  const app = buildApp({
    config,
    checkDatabase: vi.fn(),
    getAppliedSchemaHistory: vi.fn(),
    rework: {
      authenticate: vi.fn().mockResolvedValue({
        id: randomUUID(),
        displayName: "Admin",
        capabilities: input.capabilities ?? [],
        businessRoles: input.roles ?? [],
      }),
      service: rework,
      erp: {
        adapter: input.adapter,
        service: service as unknown as ErpIntegrationService,
        ...(input.integrationAuth
          ? { authenticateIntegration: vi.fn().mockResolvedValue(integrationActor) }
          : {}),
      },
    },
  });
  return { app, service };
}

describe("ERP integration routes", () => {
  it("fails closed while the production adapter is disabled", async () => {
    const { app, service } = appFor({
      adapter: new DisabledErpAdapter(),
      integrationAuth: true,
    });
    const response = await app.inject({
      method: "POST",
      url: "/integrations/erp/v1/rework-orders",
      headers: { "idempotency-key": "erp-rw-1" },
      payload,
    });
    expect(response.statusCode).toBe(503);
    expect(service.intakeFromErp).not.toHaveBeenCalled();
  });

  it("validates and accepts once before exposing the mock adapter effect", async () => {
    const adapter = new MockErpAdapter();
    const { app, service } = appFor({ adapter, integrationAuth: true });

    const invalid = await app.inject({
      method: "POST",
      url: "/integrations/erp/v1/rework-orders",
      payload,
    });
    expect(invalid.statusCode).toBe(400);
    expect(service.intakeFromErp).not.toHaveBeenCalled();
    expect(adapter.acceptedSourceRecords).toEqual([]);

    const response = await app.inject({
      method: "POST",
      url: "/integrations/erp/v1/rework-orders",
      headers: { "idempotency-key": "erp-rw-1" },
      payload,
    });
    expect(response.statusCode).toBe(201);
    expect(adapter.acceptedSourceRecords).toEqual([payload]);
    expect(service.intakeFromErp).toHaveBeenCalledWith(
      integrationActor,
      payload,
      "erp-rw-1",
    );

    service.intakeFromErp.mockResolvedValueOnce({ value: intakeResponse, reused: true });
    const replay = await app.inject({
      method: "POST",
      url: "/integrations/erp/v1/rework-orders",
      headers: { "idempotency-key": "erp-rw-1" },
      payload,
    });
    expect(replay.statusCode).toBe(201);
    expect(replay.headers["idempotency-replayed"]).toBe("true");
    expect(adapter.acceptedSourceRecords).toEqual([payload]);
  });

  it("requires system_admin, capability, reason and Idempotency-Key for emergency intake", async () => {
    const allowed = appFor({
      adapter: new DisabledErpAdapter(),
      capabilities: ["erp:emergency_intake"],
      roles: ["system_admin"],
    });
    const emergency = {
      contractVersion: "1",
      reason: "ERP临时不可用，生产不能停",
      payload: payload.payload,
    };
    expect((await allowed.app.inject({
      method: "POST",
      url: "/admin/erp-emergency/v1/rework-orders",
      headers: { "idempotency-key": "emergency-1", cookie: "dx_rework_session=test" },
      payload: emergency,
    })).statusCode).toBe(201);
    expect(allowed.service.emergencyIntake).toHaveBeenCalledWith(
      expect.objectContaining({ authorizationCapability: "erp:emergency_intake" }),
      emergency,
      "emergency-1",
    );

    expect((await allowed.app.inject({
      method: "POST",
      url: "/admin/erp-emergency/v1/rework-orders",
      headers: { cookie: "dx_rework_session=test" },
      payload: emergency,
    })).statusCode).toBe(400);

    const denied = appFor({
      adapter: new DisabledErpAdapter(),
      capabilities: [],
      roles: ["system_admin"],
    });
    expect((await denied.app.inject({
      method: "POST",
      url: "/admin/erp-emergency/v1/rework-orders",
      headers: { "idempotency-key": "emergency-1", cookie: "dx_rework_session=test" },
      payload: emergency,
    })).statusCode).toBe(403);
  });
});
