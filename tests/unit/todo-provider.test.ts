import { describe, expect, it } from "vitest";

import { DisabledDingTalkTodoProvider } from "../../apps/api/src/todos/provider.js";

describe("DingTalk todo provider boundary", () => {
  it("fails closed until a separately approved provider adapter is configured", async () => {
    await expect(new DisabledDingTalkTodoProvider().createTodo({
      todoId: "00000000-0000-4000-8000-000000000013",
      recipientUserId: "00000000-0000-4000-8000-000000000014",
      category: "process_configuration",
      deliveryKind: "create",
      route: {
        routeName: "rework_detail",
        entityId: "00000000-0000-4000-8000-000000000015",
        todoId: "00000000-0000-4000-8000-000000000013",
      },
      sourceKey: "todo:00000000-0000-4000-8000-000000000013:create:test",
      deepLink: "/ui/tasks/00000000-0000-4000-8000-000000000015",
    })).rejects.toMatchObject({ code: "DINGTALK_TODO_NOT_CONFIGURED" });
  });
});
