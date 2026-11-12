import type { ProviderId, SessionMessage } from "./types.js";

const LABELS: Record<ProviderId, string> = {
  chatgpt: "ChatGPT",
  grok: "Grok",
  gemini: "Gemini",
};

export function providerLabel(id: ProviderId): string {
  return LABELS[id];
}

export const MOCK_PREFIX = "[MOCK]";

export function mockBody(id: ProviderId, phase: "independent" | "cross_review", injectionCount: number): string {
  const phaseText = phase === "independent" ? "独立回答演示" : "交叉讨论演示";
  return `${MOCK_PREFIX} 演示数据，不是 ${providerLabel(id)} 的真实回复，不能当作模型观点。${phaseText}。注入条数=${injectionCount}。`;
}

export function notConnectedDetail(id: ProviderId): string {
  return `尚未接入 ${providerLabel(id)} 网页。这不是模型回复。`;
}

/** 给界面用的短状态。未接入和 MOCK 不会显示成「成功回答」。 */
export function outcomeHeadline(message: SessionMessage): string {
  if (message.role === "user") {
    return "用户原文";
  }
  if (message.errorCode === "adapter_contract_violation") {
    return "契约错误";
  }
  if (message.sourceKind === "mock" || message.adapterMode === "mock") {
    return message.status === "complete" ? "MOCK 演示" : `MOCK ${statusText(message.status)}`;
  }
  if (message.status === "not_connected") {
    return "未接入";
  }
  if (message.adapterMode === "unimplemented") {
    return "未接入";
  }
  if (message.trust === "local_unverified_import" && message.sourceKind === "provider") {
    return "未验证导入";
  }
  if (message.errorCode === "stopped") {
    return "已手停";
  }
  if (message.errorCode === "unknown") {
    return "未知";
  }
  if (message.errorCode === "navigation") {
    return "会话已隔离";
  }
  if (message.errorCode === "page_error") {
    return "页面错误";
  }
  if (message.errorCode === "in_flight") {
    return "已有进行中的采集";
  }
  if (message.adapterMode === "live" && message.status === "complete" && message.sourceKind === "provider") {
    return "页面结束";
  }
  return statusText(message.status);
}

export function summarizeSession(session: { messages: SessionMessage[] }): string {
  const opinions = session.messages.filter(isInjectableOpinion).length;
  const mocks = session.messages.filter((message) => message.sourceKind === "mock").length;
  const notConnected = session.messages.filter((message) => message.status === "not_connected").length;
  const failed = session.messages.filter(
    (message) => message.status === "failed" || message.status === "timeout",
  ).length;
  return `可注入观点 ${opinions} 条；MOCK 记录 ${mocks} 条；未接入 ${notConnected} 条；失败或超时 ${failed} 条。MOCK 和未接入都不是真实模型回答。`;
}

function statusText(status: SessionMessage["status"]): string {
  switch (status) {
    case "complete":
      return "完成";
    case "failed":
      return "失败";
    case "timeout":
      return "超时";
    case "not_connected":
      return "未接入";
    case "cancelled":
      return "已取消";
    default: {
      const neverStatus: never = status;
      return neverStatus;
    }
  }
}

export function isInjectableOpinion(message: SessionMessage): boolean {
  return (
    message.role === "assistant" &&
    message.status === "complete" &&
    message.phase === "independent" &&
    message.providerId !== null &&
    (message.sourceKind === "mock" || message.sourceKind === "provider") &&
    message.body.trim().length > 0
  );
}
