/** 需求基线编号。会话记录必须带上它，便于以后对回 Drive 交付物。 */
export const REQUIREMENT_ID = "AI-REQ-20261105-001" as const;

export const SCHEMA_VERSION = 1 as const;

/** 本阶段允许的最大讨论轮数。用来挡住无限互聊，不是产品最终策略。 */
export const MAX_ALLOWED_ROUNDS = 4;

export const DEFAULT_MAX_ROUNDS = 2;

/** 单条 JSONL 导入的体积上限，避免把不可信文件一次性读成无界内存。 */
export const MAX_IMPORT_CHARS = 500_000;

export const MAX_MESSAGE_BODY_CHARS = 20_000;

export const MAX_MESSAGES = 200;

export const PROVIDER_IDS = ["chatgpt", "grok", "gemini"] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

export type TurnPhase = "independent" | "cross_review";

export type MessageStatus =
  | "complete"
  | "failed"
  | "timeout"
  | "not_connected"
  | "cancelled";

/**
 * user：用户原文。
 * mock：演示数据，必须带 [MOCK] 前缀。
 * provider：将来的真实模型记录，或导入的未验证记录。当前编排器不会写出这种来源。
 * system：失败、未接入、停止条件等说明，不是模型观点。
 */
export type SourceKind = "user" | "mock" | "provider" | "system";

export type AdapterMode = "mock" | "unimplemented" | "live";

export type Trust = "created_by_core" | "local_unverified_import";

export interface Provenance {
  providerId: ProviderId;
  round: number;
  phase: TurnPhase;
  messageId: string;
}

export interface SessionMessage {
  id: string;
  sessionId: string;
  providerId: ProviderId | null;
  role: "user" | "assistant" | "system";
  round: number;
  phase: TurnPhase;
  body: string;
  createdAt: string;
  status: MessageStatus;
  sourceKind: SourceKind;
  adapterMode: AdapterMode | "none";
  provenance: Provenance[];
  errorCode: string | null;
  errorMessage: string | null;
  trust: Trust;
}

export interface Session {
  schemaVersion: typeof SCHEMA_VERSION;
  requirementId: typeof REQUIREMENT_ID;
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  maxRounds: number;
  messages: SessionMessage[];
}

export interface Injection {
  providerId: ProviderId;
  round: number;
  phase: TurnPhase;
  messageId: string;
  sourceKind: SourceKind;
  body: string;
}

export interface ProviderRequest {
  sessionId: string;
  round: number;
  phase: TurnPhase;
  userPrompt: string;
  injection: Injection[];
}

export interface ProviderResponse {
  mode: AdapterMode;
  status: MessageStatus;
  body: string;
  error?: { code: string; message: string };
}

export interface ProviderCallContext {
  signal?: AbortSignal;
}

export interface ProviderAdapter {
  id: ProviderId;
  mode: AdapterMode;
  respond(request: ProviderRequest, context?: ProviderCallContext): Promise<ProviderResponse>;
}

export interface Clock {
  now(): string;
  id(): string;
}

export interface ContextSelection {
  /** 允许被注入的来源。未选中的已完成观点不会进入其他模型的请求。 */
  sourceProviderIds: ProviderId[];
  /** 本轮应尝试评论的目标。实际是否调用还取决于有没有别人的观点。 */
  targetProviderIds: ProviderId[];
}

export type StepFailure =
  | "invalid_prompt"
  | "invalid_max_rounds"
  | "duplicate_prompt"
  | "no_providers"
  | "stop_max_rounds"
  | "no_injectable_opinions"
  | "independent_round_missing";

export type StepResult =
  | { ok: true; session: Session }
  | { ok: false; session: Session | null; reason: StepFailure; detail: string };
