import { systemClock } from "./clock.js";
import { callAdapter } from "./orchestrate.js";
import type {
  Clock,
  DeliveryReceipt,
  DeliveryState,
  GroupChatRequest,
  ProviderAdapter,
  ProviderId,
  Session,
  SessionMessage,
  StepResult,
} from "./types.js";
import { MAX_MESSAGE_BODY_CHARS, REQUIREMENT_ID, SCHEMA_VERSION } from "./types.js";

const GROUP_PROVIDERS: readonly ProviderId[] = ["chatgpt", "gemini"];

export function createGroupChatSession(title = "AI 群聊", clock: Clock = systemClock()): Session {
  const createdAt = clock.now();
  return {
    schemaVersion: SCHEMA_VERSION,
    requirementId: REQUIREMENT_ID,
    id: clock.id(),
    title: title.trim().slice(0, 40) || "AI 群聊",
    createdAt,
    updatedAt: createdAt,
    maxRounds: 4,
    messages: [],
    deliveryReceipts: [],
    groupChatRequests: [],
    groupChatPausedProviders: [],
  };
}

export function appendGroupChatMessage(
  session: Session,
  body: string,
  targets: readonly ProviderId[],
  clock: Clock = systemClock(),
): StepResult {
  if (hasUnverifiedMessages(session)) {
    return failure(session, "unverified_session", "导入记录未验证，不能继续群聊发送。");
  }
  if (session.messages.some((message) => message.phase !== "groupchat")) {
    return failure(session, "duplicate_prompt", "当前讨论页已有其他模式记录，请导出后重新打开群聊。");
  }
  const text = body.trim();
  if (!text || text.length > MAX_MESSAGE_BODY_CHARS) {
    return failure(session, "invalid_prompt", "群聊消息不能为空或超过长度上限。");
  }
  const uniqueTargets = uniqueGroupProviders(targets);
  if (uniqueTargets.length !== targets.length) {
    return failure(session, "invalid_prompt", "群聊只支持点名 ChatGPT 或 Gemini。");
  }
  const next = cloneSession(session);
  const round = next.messages.filter((message) => message.phase === "groupchat" && message.role === "user").length + 1;
  const message: SessionMessage = {
    id: clock.id(),
    sessionId: session.id,
    providerId: null,
    role: "user",
    round,
    phase: "groupchat",
    body: text,
    createdAt: clock.now(),
    status: "complete",
    sourceKind: "user",
    adapterMode: "none",
    provenance: [],
    errorCode: null,
    errorMessage: null,
    trust: "created_by_core",
    ...(uniqueTargets.length > 0 ? { targetProviders: uniqueTargets, shared: true } : { shared: false }),
  };
  next.messages.push(message);
  for (const providerId of uniqueTargets) {
    const request: GroupChatRequest = {
      id: clock.id(),
      sessionId: session.id,
      messageId: message.id,
      providerId,
      round,
      contextMessageIds: selectContextMessageIds(session, providerId),
      status: "queued",
      createdAt: message.createdAt,
      updatedAt: message.createdAt,
      errorCode: null,
      errorMessage: null,
    };
    next.groupChatRequests?.push(request);
  }
  next.updatedAt = message.createdAt;
  return { ok: true, session: next };
}

export async function runGroupChatQueues(session: Session, options: GroupChatOptions): Promise<StepResult> {
  if (hasUnverifiedMessages(session)) {
    return failure(session, "unverified_session", "导入记录未验证，不能继续群聊发送。");
  }
  const queuedProviders = uniqueGroupProviders(
    (session.groupChatRequests ?? [])
      .filter((request) => request.status === "queued")
      .map((request) => request.providerId),
  ).filter((providerId) => !(session.groupChatPausedProviders ?? []).includes(providerId));
  if (queuedProviders.length === 0) return { ok: true, session: cloneSession(session) };

  const runs = await Promise.all(queuedProviders.map((providerId) =>
    runProviderQueue(session, providerId, options),
  ));
  return { ok: true, session: mergeGroupChatExecution(session, runs) };
}

export function resumeGroupChatProvider(session: Session, providerId: ProviderId): StepResult {
  if (!isGroupProvider(providerId)) return failure(session, "invalid_prompt", "群聊只支持 ChatGPT 或 Gemini。");
  const next = cloneSession(session);
  next.groupChatPausedProviders = (next.groupChatPausedProviders ?? []).filter((id) => id !== providerId);
  return { ok: true, session: next };
}

export function cancelQueuedGroupChatRequests(session: Session, providerId?: ProviderId): StepResult {
  const next = cloneSession(session);
  const now = new Date().toISOString();
  for (const request of next.groupChatRequests ?? []) {
    if (request.status !== "queued" || (providerId && request.providerId !== providerId)) continue;
    request.status = "cancelled";
    request.updatedAt = now;
    request.errorCode = "cancelled";
    request.errorMessage = "用户取消了尚未执行的群聊请求。";
  }
  next.updatedAt = now;
  return { ok: true, session: next };
}

export function mergeGroupChatExecution(current: Session, executed: readonly Session[]): Session {
  const merged = cloneSession(current);
  const messageByRequestId = new Map(
    merged.messages
      .filter((message) => message.requestId)
      .map((message) => [message.requestId as string, message]),
  );
  const requestById = new Map((merged.groupChatRequests ?? []).map((request) => [request.id, request]));
  const receiptByKey = new Map((merged.deliveryReceipts ?? []).map((receipt) => [receiptKey(receipt), receipt]));
  const paused = new Set(merged.groupChatPausedProviders ?? []);
  for (const run of executed) {
    for (const message of run.messages) {
      if (!message.requestId) continue;
      messageByRequestId.set(message.requestId, cloneMessage(message));
    }
    for (const request of run.groupChatRequests ?? []) {
      // Each provider run carries the other provider's untouched queued requests.
      // Only merge requests that this run actually advanced.
      if (request.status !== "queued") requestById.set(request.id, cloneRequest(request));
    }
    for (const receipt of run.deliveryReceipts ?? []) receiptByKey.set(receiptKey(receipt), { ...receipt });
    for (const providerId of run.groupChatPausedProviders ?? []) paused.add(providerId);
  }
  const existingMessages = merged.messages.filter((message) => !message.requestId);
  merged.messages = [...existingMessages, ...messageByRequestId.values()]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  merged.groupChatRequests = [...requestById.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  merged.deliveryReceipts = [...receiptByKey.values()];
  merged.groupChatPausedProviders = [...paused];
  merged.updatedAt = executed.reduce((latest, run) => latest > run.updatedAt ? latest : run.updatedAt, merged.updatedAt);
  return merged;
}

export interface GroupChatOptions {
  clock: Clock;
  adapters: ProviderAdapter[];
  timeoutMs?: number;
  timeoutMsByProvider?: Partial<Record<ProviderId, number>>;
  signal?: AbortSignal;
}

async function runProviderQueue(session: Session, providerId: ProviderId, options: GroupChatOptions): Promise<Session> {
  const next = cloneSession(session);
  const requests = (next.groupChatRequests ?? []).filter((request) =>
    request.providerId === providerId && request.status === "queued",
  );
  for (const request of requests) {
    if (options.signal?.aborted) {
      cancelQueuedInPlace(next, providerId, options.clock.now());
      break;
    }
    request.status = "sending";
    request.updatedAt = options.clock.now();
    const userMessage = next.messages.find((message) => message.id === request.messageId);
    const delivered = new Set(
      (next.deliveryReceipts ?? [])
        .filter((receipt) => receipt.providerId === providerId)
        .map((receipt) => receipt.messageId),
    );
    const contextMessageIds = request.contextMessageIds.filter((id) => !delivered.has(id));
    const context = contextMessageIds.map((id) => next.messages.find((message) => message.id === id));
    if (!userMessage || context.some((message) => !message || message.status !== "complete" || !message.body.trim())) {
      const now = options.clock.now();
      const response = unknownResult(next, providerId, request, now);
      next.messages.push(response);
      finishRequest(request, "unknown", now, response.errorCode, response.errorMessage);
      pauseProvider(next, providerId);
      break;
    }
    const meetingContext = context.map((message) => toMeetingContext(message!));
    const response = await callAdapter(
      next,
      providerId,
      "groupchat",
      request.round,
      userMessage.body,
      [],
      {
        ...options,
        adapters: options.adapters,
      },
      meetingContext,
    );
    // A response belongs to the request, not to a provider-wide mutable slot.
    response.id = request.id;
    response.requestId = request.id;
    response.shared = response.status === "complete" && response.sourceKind === "provider";
    next.messages.push(response);
    const attemptedIds = [request.messageId, ...contextMessageIds];
    if (response.status === "complete") {
      finishRequest(request, "complete", options.clock.now(), null, null);
      addReceipts(next, providerId, attemptedIds, "confirmed");
      touch(next, options.clock);
      continue;
    }
    const state = isUnknown(response) ? "unknown" : response.status === "cancelled" ? "cancelled" : "failed";
    finishRequest(request, state, options.clock.now(), response.errorCode, response.errorMessage);
    addReceipts(next, providerId, attemptedIds, state === "unknown" ? "unknown" : "failed");
    touch(next, options.clock);
    if (state !== "cancelled") pauseProvider(next, providerId);
    break;
  }
  return next;
}

function selectContextMessageIds(session: Session, target: ProviderId): string[] {
  const receipts = new Map(
    (session.deliveryReceipts ?? [])
      .filter((receipt) => receipt.providerId === target)
      .map((receipt) => [receipt.messageId, receipt.state ?? "confirmed"] as const),
  );
  return session.messages
    .filter((message) =>
      message.phase === "groupchat" &&
      message.trust === "created_by_core" &&
      message.shared === true &&
      message.status === "complete" &&
      message.body.trim().length > 0 &&
      message.providerId !== target &&
      !receipts.has(message.id) &&
      (message.role === "user" || (message.role === "assistant" && message.sourceKind === "provider")),
    )
    .map((message) => message.id);
}

function toMeetingContext(message: SessionMessage) {
  return {
    messageId: message.id,
    speakerId: message.role === "user" ? "user" as const : message.providerId as ProviderId,
    round: message.round,
    phase: message.phase,
    body: message.body,
  };
}

function addReceipts(session: Session, providerId: ProviderId, messageIds: readonly string[], state: DeliveryState): void {
  const receipts = session.deliveryReceipts ?? [];
  const seen = new Set(receipts.map(receiptKey));
  for (const messageId of messageIds) {
    const receipt: DeliveryReceipt = { messageId, providerId, ...(state === "confirmed" ? {} : { state }) };
    if (seen.has(receiptKey(receipt))) continue;
    receipts.push(receipt);
    seen.add(receiptKey(receipt));
  }
  session.deliveryReceipts = receipts;
}

function finishRequest(
  request: GroupChatRequest,
  status: GroupChatRequest["status"],
  updatedAt: string,
  errorCode: string | null,
  errorMessage: string | null,
): void {
  request.status = status;
  request.updatedAt = updatedAt;
  request.errorCode = errorCode;
  request.errorMessage = errorMessage;
}

function cancelQueuedInPlace(session: Session, providerId: ProviderId, now: string): void {
  for (const request of session.groupChatRequests ?? []) {
    if (request.providerId === providerId && request.status === "queued") {
      finishRequest(request, "cancelled", now, "cancelled", "用户取消了尚未执行的群聊请求。" );
    }
  }
  touch(session, { now: () => now, id: () => "cancelled" });
}

function pauseProvider(session: Session, providerId: ProviderId): void {
  const paused = session.groupChatPausedProviders ?? [];
  if (!paused.includes(providerId)) paused.push(providerId);
  session.groupChatPausedProviders = paused;
}

function isUnknown(message: SessionMessage): boolean {
  return message.status === "timeout" || message.errorCode === "unknown" ||
    message.errorCode === "connection_lost" || message.errorCode === "page_error" ||
    message.errorCode === "ambiguous_turn";
}

function unknownResult(session: Session, providerId: ProviderId, request: GroupChatRequest, now: string): SessionMessage {
  return {
    id: request.id,
    requestId: request.id,
    sessionId: session.id,
    providerId,
    role: "system",
    round: request.round,
    phase: "groupchat",
    body: "",
    createdAt: now,
    status: "failed",
    sourceKind: "system",
    adapterMode: "none",
    provenance: [],
    errorCode: "context_missing",
    errorMessage: "群聊上下文在执行前不可用。",
    shared: false,
    trust: "created_by_core",
  };
}

function uniqueGroupProviders(values: readonly ProviderId[]): ProviderId[] {
  return [...new Set(values)].filter(isGroupProvider);
}

function isGroupProvider(value: ProviderId): value is "chatgpt" | "gemini" {
  return GROUP_PROVIDERS.includes(value);
}

function hasUnverifiedMessages(session: Session): boolean {
  return session.messages.some((message) => message.trust !== "created_by_core");
}

function receiptKey(receipt: Pick<DeliveryReceipt, "messageId" | "providerId">): string {
  return `${receipt.messageId}:${receipt.providerId}`;
}

function cloneRequest(request: GroupChatRequest): GroupChatRequest {
  return { ...request, contextMessageIds: [...request.contextMessageIds] };
}

function cloneMessage(message: SessionMessage): SessionMessage {
  return {
    ...message,
    provenance: message.provenance.map((item) => ({ ...item })),
    ...(message.targetProviders ? { targetProviders: [...message.targetProviders] } : {}),
  };
}

function cloneSession(session: Session): Session {
  return {
    ...session,
    messages: session.messages.map(cloneMessage),
    deliveryReceipts: (session.deliveryReceipts ?? []).map((receipt) => ({ ...receipt })),
    groupChatRequests: (session.groupChatRequests ?? []).map(cloneRequest),
    groupChatPausedProviders: [...(session.groupChatPausedProviders ?? [])],
  };
}

function touch(session: Session, clock: Clock): void {
  session.updatedAt = session.messages.at(-1)?.createdAt ?? clock.now();
}

function failure(session: Session, reason: "invalid_prompt" | "duplicate_prompt" | "unverified_session", detail: string): StepResult {
  return { ok: false, session, reason, detail };
}
