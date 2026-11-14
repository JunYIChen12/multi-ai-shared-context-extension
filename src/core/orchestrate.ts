import { injectionsForTarget, selectInjections } from "./context.js";
import { MOCK_PREFIX, notConnectedDetail } from "./labels.js";
import { adaptersById } from "./providers.js";
import type {
  Clock,
  ContextSelection,
  ProviderAdapter,
  ProviderId,
  ProviderRequest,
  ProviderResponse,
  Session,
  SessionMessage,
  StepResult,
  TurnPhase,
} from "./types.js";
import { DEFAULT_MAX_ROUNDS, MAX_ALLOWED_ROUNDS, MAX_MESSAGE_BODY_CHARS } from "./types.js";

export interface OrchestratorOptions {
  clock: Clock;
  adapters: ProviderAdapter[];
  timeoutMs?: number;
  timeoutMsByProvider?: Partial<Record<ProviderId, number>>;
  maxRounds?: number;
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export function createSession(prompt: string, options: OrchestratorOptions): StepResult {
  const trimmed = prompt.trim();
  if (!trimmed) {
    return { ok: false, session: null, reason: "invalid_prompt", detail: "问题不能为空" };
  }
  if (trimmed.length > MAX_MESSAGE_BODY_CHARS) {
    return { ok: false, session: null, reason: "invalid_prompt", detail: "问题超过长度上限" };
  }
  const maxRounds = options.maxRounds ?? DEFAULT_MAX_ROUNDS;
  if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > MAX_ALLOWED_ROUNDS) {
    return {
      ok: false,
      session: null,
      reason: "invalid_max_rounds",
      detail: `maxRounds 必须是 1 到 ${MAX_ALLOWED_ROUNDS} 的整数`,
    };
  }
  const createdAt = options.clock.now();
  const session: Session = {
    schemaVersion: 1,
    requirementId: "AI-REQ-20261105-001",
    id: options.clock.id(),
    title: trimmed.slice(0, 40),
    createdAt,
    updatedAt: createdAt,
    maxRounds,
    messages: [],
  };
  session.messages.push(userMessage(session.id, trimmed, options.clock));
  session.updatedAt = session.messages[0]?.createdAt ?? createdAt;
  return { ok: true, session };
}

export async function runIndependentRound(
  session: Session,
  options: OrchestratorOptions,
): Promise<StepResult> {
  const prompt = latestUserPrompt(session);
  if (!prompt) {
    return { ok: false, session, reason: "invalid_prompt", detail: "会话里没有用户原文" };
  }
  if (session.messages.some((message) => message.phase === "independent" && message.role !== "user")) {
    return {
      ok: false,
      session,
      reason: "duplicate_prompt",
      detail: "独立回答已经记录过。重复点击不会再跑一遍。",
    };
  }
  try {
    adaptersById(options.adapters);
  } catch (error) {
    return {
      ok: false,
      session,
      reason: "no_providers",
      detail: error instanceof Error ? error.message : "适配器配置无效",
    };
  }
  const targets = uniqueProviderIds(options.adapters);
  if (targets.length === 0) {
    return { ok: false, session, reason: "no_providers", detail: "没有选择任何模型" };
  }
  const next = cloneSession(session);
  const replies = await Promise.all(
    targets.map((providerId) =>
      callAdapter(next, providerId, "independent", 1, prompt, [], options),
    ),
  );
  next.messages.push(...replies);
  touch(next, options.clock);
  return { ok: true, session: next };
}

export async function runCrossReview(
  session: Session,
  selection: ContextSelection,
  options: OrchestratorOptions,
): Promise<StepResult> {
  if (session.maxRounds < 2) {
    return {
      ok: false,
      session,
      reason: "stop_max_rounds",
      detail: "已达到停止条件：maxRounds 小于 2，不再进行交叉讨论。",
    };
  }
  if (session.messages.some((message) => message.phase === "cross_review")) {
    return {
      ok: false,
      session,
      reason: "duplicate_prompt",
      detail: "交叉讨论已经记录过。重复点击不会再跑一遍。",
    };
  }
  const independentDone = session.messages.some(
    (message) => message.phase === "independent" && message.role !== "user",
  );
  if (!independentDone) {
    return {
      ok: false,
      session,
      reason: "independent_round_missing",
      detail: "还没有第一轮记录，不能开始交叉讨论。",
    };
  }
  const prompt = latestUserPrompt(session);
  if (!prompt) {
    return { ok: false, session, reason: "invalid_prompt", detail: "会话里没有用户原文" };
  }
  const pool = selectInjections(session, selection.sourceProviderIds);
  if (pool.length === 0 || selection.targetProviderIds.length === 0) {
    return {
      ok: false,
      session,
      reason: "no_injectable_opinions",
      detail: "没有可注入的已完成观点。未接入或失败记录不会被当成模型观点。",
    };
  }

  let known: Map<ProviderId, ProviderAdapter>;
  try {
    known = adaptersById(options.adapters);
  } catch (error) {
    return {
      ok: false,
      session,
      reason: "no_providers",
      detail: error instanceof Error ? error.message : "适配器配置无效",
    };
  }
  const next = cloneSession(session);
  const replies = await Promise.all(
    uniqueIds(selection.targetProviderIds).map((targetId) =>
      reviewTarget(next, targetId, prompt, pool, known, options),
    ),
  );
  next.messages.push(...replies);
  touch(next, options.clock);
  return { ok: true, session: next };
}

export async function callAdapter(
  session: Session,
  providerId: ProviderId,
  phase: TurnPhase,
  round: number,
  userPrompt: string,
  injection: ProviderRequest["injection"],
  options: OrchestratorOptions,
  meetingContext: ProviderRequest["meetingContext"] = [],
): Promise<SessionMessage> {
  const adapter = options.adapters.find((item) => item.id === providerId);
  const createdAt = options.clock.now();
  const base = {
    id: options.clock.id(),
    sessionId: session.id,
    providerId,
    round,
    phase,
    createdAt,
    provenance: [
      ...injection.map((item) => ({
        providerId: item.providerId,
        round: item.round,
        phase: item.phase,
        messageId: item.messageId,
      })),
      ...(meetingContext ?? []).flatMap((item) => item.speakerId === "user" ? [] : [{
        providerId: item.speakerId,
        round: item.round,
        phase: item.phase,
        messageId: item.messageId,
      }]),
    ],
    trust: "created_by_core" as const,
  };
  if (!adapter) {
    return {
      ...base,
      role: "system",
      body: "",
      status: "not_connected",
      sourceKind: "system",
      adapterMode: "unimplemented",
      errorCode: "not_connected",
      errorMessage: notConnectedDetail(providerId),
    };
  }

  const request: ProviderRequest = {
    sessionId: session.id,
    round,
    phase,
    userPrompt,
    injection,
    ...(meetingContext ? { meetingContext } : {}),
  };
  const timeoutMs = options.timeoutMsByProvider?.[providerId] ?? options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let removeAbortListener: () => void = () => undefined;
  if (options.signal?.aborted) return stoppedMessage(base, providerId, adapter.mode);
  let rejectOnStop: ((error: Error) => void) | undefined;
  const stopped = new Promise<never>((_, reject) => { rejectOnStop = reject; });
  const onExternalAbort = () => {
    controller.abort();
    rejectOnStop?.(new Error("stopped"));
  };
  if (options.signal) {
    options.signal.addEventListener("abort", onExternalAbort, { once: true });
    removeAbortListener = () => options.signal?.removeEventListener("abort", onExternalAbort);
  }
  const pending = adapter.respond(request, { signal: controller.signal });
  void pending.catch(() => undefined);
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("timeout"));
    }, timeoutMs);
  });
  try {
    const response = await Promise.race([pending, timeout, stopped]);
    if (options.signal?.aborted) {
      return stoppedMessage(base, providerId, adapter.mode);
    }
    if (controller.signal.aborted) {
      return timeoutMessage(base, providerId, timeoutMs, adapter.mode);
    }
    return messageFromResponse(base, response, injection, meetingContext ?? []);
  } catch (error) {
    if (options.signal?.aborted) return stoppedMessage(base, providerId, adapter.mode);
    const timedOut = controller.signal.aborted || (error instanceof Error && error.message === "timeout");
    if (timedOut) {
      return timeoutMessage(base, providerId, timeoutMs, adapter.mode);
    }
    return {
      ...base,
      role: "system",
      body: "",
      status: "failed",
      sourceKind: "system",
      adapterMode: adapter.mode,
      errorCode: "adapter_error",
      errorMessage: shortError(error),
    };
  } finally {
    removeAbortListener();
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function stoppedMessage(
  base: Omit<SessionMessage, "role" | "body" | "status" | "sourceKind" | "adapterMode" | "errorCode" | "errorMessage">,
  providerId: ProviderId,
  adapterMode: SessionMessage["adapterMode"],
): SessionMessage {
  return {
    ...base,
    role: "system",
    body: "",
    status: "cancelled",
    sourceKind: "system",
    adapterMode,
    errorCode: "stopped",
    errorMessage: `用户已停止本场；${providerId} 的结果未采信`,
  };
}

function timeoutMessage(
  base: Omit<
    SessionMessage,
    "role" | "body" | "status" | "sourceKind" | "adapterMode" | "errorCode" | "errorMessage"
  >,
  providerId: ProviderId,
  timeoutMs: number,
  adapterMode: SessionMessage["adapterMode"],
): SessionMessage {
  return {
    ...base,
    role: "system",
    body: "",
    status: "timeout",
    sourceKind: "system",
    adapterMode,
    errorCode: "timeout",
    errorMessage: `${providerId} 超过 ${timeoutMs}ms 仍未完成`,
  };
}

function messageFromResponse(
  base: Omit<
    SessionMessage,
    "role" | "body" | "status" | "sourceKind" | "adapterMode" | "errorCode" | "errorMessage"
  >,
  response: ProviderResponse,
  injection: ProviderRequest["injection"],
  meetingContext: NonNullable<ProviderRequest["meetingContext"]>,
): SessionMessage {
  const violation = contractViolation(response);
  if (violation) {
    return {
      ...base,
      role: "system",
      body: "",
      status: "failed",
      sourceKind: "system",
      adapterMode: response.mode,
      errorCode: "adapter_contract_violation",
      errorMessage: violation,
    };
  }
  const failed = response.status !== "complete";
  return {
    ...base,
    role: failed ? "system" : "assistant",
    body: failed ? "" : response.body,
    status: response.status,
    sourceKind:
      response.status !== "complete"
        ? "system"
        : response.mode === "mock"
          ? "mock"
          : "provider",
    adapterMode: response.mode,
    errorCode: response.error?.code ?? null,
    errorMessage: response.error?.message ?? null,
    provenance: [
      ...injection.map((item) => ({
        providerId: item.providerId,
        round: item.round,
        phase: item.phase,
        messageId: item.messageId,
      })),
      ...meetingContext.flatMap((item) => item.speakerId === "user" ? [] : [{
        providerId: item.speakerId,
        round: item.round,
        phase: item.phase,
        messageId: item.messageId,
      }]),
    ],
  };
}

export function contractViolation(response: ProviderResponse): string | null {
  if (response.mode === "unimplemented" && response.status === "complete") {
    return "未实现适配器不能返回 complete";
  }
  if (response.mode === "mock" && response.status === "complete" && !response.body.startsWith(MOCK_PREFIX)) {
    return "MOCK 完成回复必须以 [MOCK] 开头";
  }
  if (response.mode === "live" && response.status === "complete" && !response.body.trim()) {
    return "live 完成回复必须有正文";
  }
  if (response.body.length > MAX_MESSAGE_BODY_CHARS) {
    return "适配器回复超过长度上限";
  }
  return null;
}

async function reviewTarget(
  session: Session,
  targetId: ProviderId,
  prompt: string,
  pool: ProviderRequest["injection"],
  known: Map<ProviderId, ProviderAdapter>,
  options: OrchestratorOptions,
): Promise<SessionMessage> {
  const injection = injectionsForTarget(pool, targetId);
  if (injection.length === 0) {
    return systemNote(session.id, targetId, "没有其他来源的已完成观点可评论。", "no_other_sources", options.clock);
  }
  const adapter = known.get(targetId);
  if (!adapter) {
    return systemNote(session.id, targetId, notConnectedDetail(targetId), "not_connected", options.clock);
  }
  return callAdapter(session, targetId, "cross_review", 2, prompt, injection, {
    ...options,
    adapters: [adapter],
  });
}

function userMessage(sessionId: string, body: string, clock: Clock): SessionMessage {
  return {
    id: clock.id(),
    sessionId,
    providerId: null,
    role: "user",
    round: 1,
    phase: "independent",
    body,
    createdAt: clock.now(),
    status: "complete",
    sourceKind: "user",
    adapterMode: "none",
    provenance: [],
    errorCode: null,
    errorMessage: null,
    trust: "created_by_core",
  };
}

function systemNote(
  sessionId: string,
  providerId: ProviderId,
  detail: string,
  code: string,
  clock: Clock,
): SessionMessage {
  return {
    id: clock.id(),
    sessionId,
    providerId,
    role: "system",
    round: 2,
    phase: "cross_review",
    body: "",
    createdAt: clock.now(),
    status: code === "not_connected" ? "not_connected" : "failed",
    sourceKind: "system",
    adapterMode: "none",
    provenance: [],
    errorCode: code,
    errorMessage: detail,
    trust: "created_by_core",
  };
}

function latestUserPrompt(session: Session): string | null {
  for (let index = session.messages.length - 1; index >= 0; index -= 1) {
    const message = session.messages[index];
    if (message?.role === "user") {
      return message.body;
    }
  }
  return null;
}

function uniqueProviderIds(adapters: ProviderAdapter[]): ProviderId[] {
  return uniqueIds(adapters.map((adapter) => adapter.id));
}

function uniqueIds(ids: readonly ProviderId[]): ProviderId[] {
  const seen = new Set<ProviderId>();
  const result: ProviderId[] = [];
  for (const id of ids) {
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    result.push(id);
  }
  return result;
}

function cloneSession(session: Session): Session {
  return {
    ...session,
    messages: session.messages.map((message) => ({
      ...message,
      provenance: message.provenance.map((item) => ({ ...item })),
    })),
  };
}

function touch(session: Session, clock: Clock): void {
  const last = session.messages[session.messages.length - 1];
  session.updatedAt = last?.createdAt ?? clock.now();
}

function shortError(error: unknown): string {
  if (error instanceof Error && error.message && error.message !== "timeout") {
    return error.message.slice(0, 300);
  }
  return "适配器调用失败";
}
