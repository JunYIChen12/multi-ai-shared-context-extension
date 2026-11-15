import { formatRoundtableContext, selectRoundtableContext } from "./context.js";
import { systemClock } from "./clock.js";
import { callAdapter, createSession, type OrchestratorOptions } from "./orchestrate.js";
import type { Clock, ProviderId, Session, SessionMessage, StepResult } from "./types.js";
import { MAX_ALLOWED_ROUNDS, MAX_MESSAGE_BODY_CHARS } from "./types.js";

const DEFAULT_TARGETS: readonly ProviderId[] = ["chatgpt", "gemini"];

export function createRoundtableSession(prompt: string, options: OrchestratorOptions): StepResult {
  const created = createSession(prompt, { ...options, maxRounds: options.maxRounds ?? MAX_ALLOWED_ROUNDS });
  if (!created.ok) return created;
  const session = cloneSession(created.session);
  const first = session.messages[0];
  if (first) first.phase = "roundtable";
  session.deliveryReceipts = [];
  return { ok: true, session };
}

/** 只把补充写入会话；是否发送由用户之后点击「继续」决定。 */
export function appendRoundtableUserInput(
  session: Session,
  body: string,
  directedTo?: ProviderId,
  clock: Clock = systemClock(),
): StepResult {
  if (hasUnverifiedRoundtableMessages(session)) {
    return failure(session, "unverified_session", "导入记录未验证，不能继续圆桌发送。");
  }
  if (hasTerminalFailure(session)) return failure(session, "meeting_stopped", "本场已停止，不能继续发送。");
  const completedRound = completedProviderRound(session);
  if (!isRoundComplete(session, completedRound)) {
    return failure(session, completedRound === 0 ? "awaiting_continue" : "meeting_round_incomplete", "当前一轮尚未完整结束。");
  }
  if (completedRound >= session.maxRounds) {
    return failure(session, "stop_max_rounds", `已达到 ${session.maxRounds} 轮上限。`);
  }
  if (session.messages.some((message) => message.phase === "roundtable" && message.role === "user" && message.round > completedRound)) {
    return failure(session, "duplicate_prompt", "已有一条等待继续的用户补充，请先推进或停止本轮。");
  }
  const trimmed = body.trim();
  if (!trimmed || trimmed.length > MAX_MESSAGE_BODY_CHARS) {
    return failure(session, "invalid_prompt", "补充内容为空或超过单条长度上限。");
  }
  if (directedTo && directedTo !== "chatgpt" && directedTo !== "gemini") {
    return failure(session, "invalid_prompt", "圆桌模式只支持 @ChatGPT 或 @Gemini。");
  }
  const next = cloneSession(session);
  const message: SessionMessage = {
    id: clock.id(),
    sessionId: session.id,
    providerId: null,
    role: "user",
    round: completedRound + 1,
    phase: "roundtable",
    body: trimmed,
    createdAt: clock.now(),
    status: "complete",
    sourceKind: "user",
    adapterMode: "none",
    provenance: [],
    errorCode: null,
    errorMessage: null,
    trust: "created_by_core",
    ...(directedTo ? { directedTo } : {}),
  };
  next.messages.push(message);
  next.updatedAt = message.createdAt;
  return { ok: true, session: next };
}

/** 按固定顺序逐家发送；一旦失败、超时或停止，立即收住本场。 */
export async function runRoundtableRound(session: Session, options: OrchestratorOptions): Promise<StepResult> {
  if (hasUnverifiedRoundtableMessages(session)) {
    return failure(session, "unverified_session", "导入记录未验证，不能继续圆桌发送。");
  }
  if (hasTerminalFailure(session)) return failure(session, "meeting_stopped", "本场已停止，不能继续发送。");
  const completedRound = completedProviderRound(session);
  const round = completedRound + 1;
  if (round > session.maxRounds) return failure(session, "stop_max_rounds", `已达到 ${session.maxRounds} 轮上限。`);
  const pending = session.messages.filter(
    (message) => message.phase === "roundtable" && message.role === "user" && message.round === round,
  );
  if (pending.length !== 1) return failure(session, "awaiting_continue", "请先记录本轮用户发言，再点击继续。");
  if (session.messages.some((message) => message.phase === "roundtable" && message.role !== "user" && message.round === round)) {
    return failure(session, "duplicate_prompt", "本轮已经开始，不会重复发送。");
  }
  const userMessage = pending[0];
  if (!userMessage) return failure(session, "awaiting_continue", "没有待发送的用户发言。");
  const targets = userMessage.directedTo ? [userMessage.directedTo] : DEFAULT_TARGETS;
  const next = cloneSession(session);

  for (const providerId of targets) {
    if (options.signal?.aborted) {
      next.messages.push(stoppedMessage(session.id, providerId, round, options.clock));
      touch(next, options.clock);
      return { ok: true, session: next };
    }
    const meetingContext = selectRoundtableContext(next, providerId, userMessage.id);
    const response = await callAdapter(
      next,
      providerId,
      "roundtable",
      round,
      userMessage.body,
      [],
      options,
      meetingContext,
    );
    next.messages.push(response);
    if (response.status !== "complete" || response.role !== "assistant") {
      touch(next, options.clock);
      return { ok: true, session: next };
    }
    addDeliveryReceipts(next, providerId, [userMessage.id, ...meetingContext.map((item) => item.messageId)]);
    touch(next, options.clock);
  }
  return { ok: true, session: next };
}

export { formatRoundtableContext };

function completedProviderRound(session: Session): number {
  return session.messages.reduce((round, message) =>
    message.phase === "roundtable" && message.role !== "user" ? Math.max(round, message.round) : round, 0);
}

function isRoundComplete(session: Session, round: number): boolean {
  if (round < 1 || hasTerminalFailure(session)) return false;
  const user = session.messages.find((message) => message.phase === "roundtable" && message.role === "user" && message.round === round);
  if (!user) return false;
  const targets = user.directedTo ? [user.directedTo] : DEFAULT_TARGETS;
  return targets.every((providerId) => session.messages.some((message) =>
    message.phase === "roundtable" && message.round === round && message.providerId === providerId &&
    message.role === "assistant" && message.status === "complete" && message.sourceKind === "provider"));
}

export function canSelectNextRoundTarget(session: Session): boolean {
  const completedRound = completedProviderRound(session);
  return completedRound > 0 && completedRound < session.maxRounds && isRoundComplete(session, completedRound) &&
    !session.messages.some((message) => message.phase === "roundtable" &&
      message.role === "user" && message.round > completedRound);
}

export function allowsNewIndependentSession(session: Session | null): boolean {
  return session === null || !session.messages.some((message) => message.phase === "roundtable");
}

function hasTerminalFailure(session: Session): boolean {
  return session.messages.some((message) =>
    message.phase === "roundtable" && message.role !== "user" && message.status !== "complete");
}

function hasUnverifiedRoundtableMessages(session: Session): boolean {
  return session.messages.some((message) => message.phase === "roundtable" && message.trust !== "created_by_core");
}

function addDeliveryReceipts(session: Session, providerId: ProviderId, messageIds: readonly string[]): void {
  const receipts = session.deliveryReceipts ?? [];
  const seen = new Set(receipts.map((receipt) => `${receipt.messageId}:${receipt.providerId}`));
  for (const messageId of messageIds) {
    const key = `${messageId}:${providerId}`;
    if (seen.has(key)) continue;
    receipts.push({ messageId, providerId });
    seen.add(key);
  }
  session.deliveryReceipts = receipts;
}

function stoppedMessage(sessionId: string, providerId: ProviderId, round: number, clock: Clock): SessionMessage {
  return {
    id: clock.id(),
    sessionId,
    providerId,
    role: "system",
    round,
    phase: "roundtable",
    body: "",
    createdAt: clock.now(),
    status: "cancelled",
    sourceKind: "system",
    adapterMode: "live",
    provenance: [],
    errorCode: "stopped",
    errorMessage: "用户已停止本场，未发送给下一家模型。",
    trust: "created_by_core",
  };
}

function cloneSession(session: Session): Session {
  return {
    ...session,
    deliveryReceipts: (session.deliveryReceipts ?? []).map((receipt) => ({ ...receipt })),
    messages: session.messages.map((message) => ({
      ...message,
      provenance: message.provenance.map((item) => ({ ...item })),
    })),
  };
}

function touch(session: Session, clock: Clock): void {
  session.updatedAt = session.messages.at(-1)?.createdAt ?? clock.now();
}

function failure(session: Session, reason: "invalid_prompt" | "duplicate_prompt" | "stop_max_rounds" | "meeting_stopped" | "awaiting_continue" | "meeting_round_incomplete" | "unverified_session", detail: string): StepResult {
  return { ok: false, session, reason, detail };
}
