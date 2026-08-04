import type { TodoRouteDescriptor } from "@dx-rework/contracts";

export type DingTalkTodoDelivery = Readonly<{
  todoId: string;
  recipientUserId: string;
  category: string;
  deliveryKind: "create" | "reminder" | "escalation" | "information";
  route: TodoRouteDescriptor;
  deepLink: string;
}>;

export type DingTalkTodoDeliveryReceipt = Readonly<{ providerMessageId: string }>;

/**
 * A deliberately narrow boundary. The official DingTalk todo endpoint and
 * configuration are not in the Golden Source, so production delivery stays
 * disabled until a separately approved adapter is supplied.
 */
export interface DingTalkTodoProvider {
  deliver(input: DingTalkTodoDelivery): Promise<DingTalkTodoDeliveryReceipt>;
}

export class DingTalkTodoDeliveryError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "DingTalkTodoDeliveryError";
  }
}

export class DisabledDingTalkTodoProvider implements DingTalkTodoProvider {
  async deliver(): Promise<DingTalkTodoDeliveryReceipt> {
    throw new DingTalkTodoDeliveryError(
      "DINGTALK_TODO_NOT_CONFIGURED",
      "DingTalk todo delivery is not configured",
    );
  }
}
