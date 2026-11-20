import { TodoCountIndicatorSchema, type TodoCountIndicator } from "@dx-rework/contracts";
import { createWebUrls } from "../url-contract.js";
import { cachedVerifiedSession, registerSessionInvalidator, sessionCacheVersion } from "./auth-session.js";

const { apiUrl } = createWebUrls(import.meta.env.BASE_URL);

type IndicatorResult = TodoCountIndicator | "actor_changed" | null;
type IndicatorRead = {
  actorId: string;
  epoch: number;
  controller: AbortController;
  result: Promise<IndicatorResult>;
};

let inFlight: IndicatorRead | undefined;

export function isCurrentTodoIndicatorActor(actorId: string, epoch: number): boolean {
  const session = cachedVerifiedSession();
  return epoch === sessionCacheVersion() && !!session && session !== "denied"
    && session.user.id === actorId && session.user.capabilities.includes("todo:view");
}

registerSessionInvalidator(() => {
  inFlight?.controller.abort();
  inFlight = undefined;
});

export function readTodoIndicator(actorId: string, epoch: number): Promise<IndicatorResult> {
  if (!isCurrentTodoIndicatorActor(actorId, epoch)) return Promise.resolve(null);
  if (inFlight?.actorId === actorId && inFlight.epoch === epoch) return inFlight.result;

  inFlight?.controller.abort();
  const controller = new AbortController();
  const current = () => !controller.signal.aborted && isCurrentTodoIndicatorActor(actorId, epoch);
  const result = fetch(apiUrl("todos/mine/indicator"), {
    credentials: "include",
    headers: { accept: "application/json" },
    signal: controller.signal,
  }).then(async (response): Promise<IndicatorResult> => {
    if (!current() || !response.ok) return null;
    if (response.headers.get("x-dx-rework-actor-id") !== actorId) return "actor_changed";
    const indicator = TodoCountIndicatorSchema.parse(await response.json());
    return current() ? indicator : null;
  }).catch((error: unknown) => {
    if (current()) console.warn("Todo indicator refresh failed", error);
    return null;
  }).finally(() => {
    if (inFlight?.controller === controller) inFlight = undefined;
  });
  inFlight = { actorId, epoch, controller, result };
  return result;
}
