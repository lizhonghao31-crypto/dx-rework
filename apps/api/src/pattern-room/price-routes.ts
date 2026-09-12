import { PatternPriceChangeSchema, PatternPriceParamsSchema, type PatternPriceCapability } from "@dx-rework/contracts/pattern-room";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { z } from "zod";
import { businessActor } from "../access/business-authority.js";
import type { RootAuthority } from "../access/root-authority.js";
import type { AuthUser } from "../auth/service.js";
import { ApplicationError } from "../platform/errors.js";
import { assertPatternPriceAccess, PATTERN_HOURLY_PRICE_ID, type PatternRoomPriceService } from "./price-service.js";

export type PatternRoomPriceDependencies = { authenticate(token: string | undefined): Promise<AuthUser>; service: PatternRoomPriceService; root?: RootAuthority };
const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ApplicationError("VALIDATION_ERROR", "请检查价格与必填信息", 400);
  return parsed.data;
};
export function registerPatternRoomPriceRoutes(app: FastifyInstance, dependencies: PatternRoomPriceDependencies): void {
  const actor = async (request: FastifyRequest, capability: PatternPriceCapability) => {
    const token = request.headers.cookie?.split(";").map(value => value.trim()).find(value => value.startsWith("dx_rework_session="))?.slice(18);
    const trusted = await businessActor(dependencies.root, await dependencies.authenticate(token), request.id, capability);
    assertPatternPriceAccess(trusted, capability);
    return trusted;
  };
  const key = (request: FastifyRequest) => typeof request.headers["idempotency-key"] === "string" ? request.headers["idempotency-key"] : "";
  app.get("/pattern-room/prices", async (request, reply) => {
    reply.header("cache-control", "no-store");
    return dependencies.service.management(await actor(request, "pattern_room:prices:read"));
  });
  app.get("/pattern-room/prices/:priceId/history", async (request, reply) => {
    reply.header("cache-control", "no-store");
    return dependencies.service.history(await actor(request, "pattern_room:prices:read"), parse(PatternPriceParamsSchema, request.params).priceId);
  });
  app.get("/pattern-room/category-options", async (request, reply) => {
    reply.header("cache-control", "no-store");
    return dependencies.service.options(await actor(request, "pattern_room:catalog:read"));
  });
  app.get("/pattern-room/category-options/:priceId/quote", async (request, reply) => {
    reply.header("cache-control", "no-store");
    return dependencies.service.quote(await actor(request, "pattern_room:catalog:read"), "category", parse(PatternPriceParamsSchema, request.params).priceId);
  });
  app.get("/pattern-room/hourly-quote", async (request, reply) => {
    reply.header("cache-control", "no-store");
    return dependencies.service.quote(await actor(request, "pattern_room:misc:quote"), "hourly", PATTERN_HOURLY_PRICE_ID);
  });
  app.post("/pattern-room/prices/categories/:priceId", async request => dependencies.service.change(
    await actor(request, "pattern_room:prices:write"), "category", parse(PatternPriceParamsSchema, request.params).priceId,
    parse(PatternPriceChangeSchema, request.body), key(request)));
  app.post("/pattern-room/prices/hourly", async request => dependencies.service.change(
    await actor(request, "pattern_room:hourly:write"), "hourly", PATTERN_HOURLY_PRICE_ID, parse(PatternPriceChangeSchema, request.body), key(request)));
}
