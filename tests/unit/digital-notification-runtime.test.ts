import { afterEach,describe,expect,it,vi } from "vitest";
import { DigitalNotificationRuntime } from "../../apps/api/src/production-platform/notification-runtime.js";
import { buildTodoDeepLink,buildTodoExternalDeepLink } from "../../apps/api/src/todos/deep-link.js";
import { readTodoQuery } from "../../apps/web/src/todo-query-state.js";
describe("digital notification runtime and navigation",()=>{
  afterEach(()=>vi.useRealTimers());
  it("starts independently of external delivery, prevents overlapping scans and drains before shutdown",async()=>{
    vi.useFakeTimers();let release!:()=>void;
    const runOnce=vi.fn(()=>new Promise<void>(resolve=>{release=resolve;}));
    const runtime=new DigitalNotificationRuntime({runOnce},{warn:vi.fn()},1000);
    runtime.start();runtime.start();await vi.advanceTimersByTimeAsync(3000);expect(runOnce).toHaveBeenCalledTimes(1);
    const stopped=runtime.stop();release();await stopped;await vi.advanceTimersByTimeAsync(3000);expect(runOnce).toHaveBeenCalledTimes(1);
  });
  it("links back to the real task, retains todo filter on refresh and rejects digital external links",()=>{
    const id="00000000-0000-4000-8000-000000000004",route={routeName:"digital_production_task" as const,entityId:id,todoId:id};
    expect(buildTodoDeepLink("/acceptance/",route)).toBe(`/acceptance/ui/digital-production?todo=${id}&task=${id}`);
    expect(()=>buildTodoExternalDeepLink("https://example.test/",route)).toThrow("仅限站内");
    expect(readTodoQuery("?module=digital_production&page=2")).toEqual({q:"",module:"digital_production",page:2});
  });
});
