import { isInjectableOpinion } from "./labels.js";
import type { ContextSelection, Injection, ProviderId, Session, SessionMessage } from "./types.js";

export function selectInjections(session: Session, sourceProviderIds: readonly ProviderId[]): Injection[] {
  const allowed = new Set(sourceProviderIds);
  const injections: Injection[] = [];
  for (const message of session.messages) {
    if (!message.providerId || !allowed.has(message.providerId)) {
      continue;
    }
    if (!isInjectableOpinion(message)) {
      continue;
    }
    injections.push(toInjection(message));
  }
  return injections;
}

export function injectionsForTarget(injections: readonly Injection[], target: ProviderId): Injection[] {
  return injections.filter((item) => item.providerId !== target);
}

export function emptySelection(): ContextSelection {
  return { sourceProviderIds: [], targetProviderIds: [] };
}

function toInjection(message: SessionMessage): Injection {
  if (!message.providerId) {
    throw new Error("可注入观点必须有 providerId");
  }
  return {
    providerId: message.providerId,
    round: message.round,
    phase: message.phase,
    messageId: message.id,
    sourceKind: message.sourceKind,
    body: message.body,
  };
}

/** 纯文本清单。调用方只能把它当数据，不能当 HTML 或指令执行。 */
export function formatInjection(items: readonly Injection[]): string {
  if (items.length === 0) {
    return "（没有可注入的已完成观点）";
  }
  return items
    .map((item) => {
      return [
        `【来自 ${item.providerId} 第 ${item.round} 轮 ${item.phase} message:${item.messageId} kind:${item.sourceKind}】`,
        item.body,
      ].join("\n");
    })
    .join("\n\n");
}
