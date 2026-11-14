import { isInjectableOpinion } from "./labels.js";
import { providerLabel } from "./labels.js";
import type { ContextSelection, Injection, MeetingContextItem, ProviderId, Session, SessionMessage } from "./types.js";

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

/** 只选择目标模型尚未收到的本场用户原话和其他模型完整发言。 */
export function selectRoundtableContext(
  session: Session,
  target: ProviderId,
  primaryUserMessageId: string,
): MeetingContextItem[] {
  const received = new Set(
    (session.deliveryReceipts ?? [])
      .filter((receipt) => receipt.providerId === target)
      .map((receipt) => receipt.messageId),
  );
  const selected: MeetingContextItem[] = [];
  for (const message of session.messages) {
    if (message.phase !== "roundtable" || message.trust !== "created_by_core" || received.has(message.id)) continue;
    if (message.role === "user") {
      if (message.id === primaryUserMessageId || message.status !== "complete") continue;
      selected.push({
        messageId: message.id,
        speakerId: "user",
        round: message.round,
        phase: message.phase,
        body: message.body,
      });
      continue;
    }
    if (
      message.role === "assistant" && message.providerId !== null && message.providerId !== target &&
      message.status === "complete" && message.sourceKind === "provider" && message.body.trim()
    ) {
      selected.push({
        messageId: message.id,
        speakerId: message.providerId,
        round: message.round,
        phase: message.phase,
        body: message.body,
      });
    }
  }
  return selected;
}

/** 将选中的原文标注说话者；正文原样保留，不截断、不摘要。 */
export function formatRoundtableContext(items: readonly MeetingContextItem[]): string {
  return items.map((item) => {
    const speaker = item.speakerId === "user" ? "用户" : providerLabel(item.speakerId);
    return `【${speaker} · 第 ${item.round} 轮完整原话】\n${item.body}`;
  }).join("\n\n");
}

export function formatRoundtablePrompt(
  userPrompt: string,
  round: number,
  items: readonly MeetingContextItem[],
): string {
  const current = `【用户 · 第 ${round} 轮新发言】\n${userPrompt}`;
  const previous = formatRoundtableContext(items);
  return previous ? `${previous}\n\n${current}` : current;
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
