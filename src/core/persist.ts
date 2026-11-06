import { isInjectableOpinion, outcomeHeadline, providerLabel } from "./labels.js";
import type { Provenance, ProviderId, Session, SessionMessage, Trust } from "./types.js";
import {
  MAX_ALLOWED_ROUNDS,
  MAX_IMPORT_CHARS,
  MAX_MESSAGE_BODY_CHARS,
  MAX_MESSAGES,
  PROVIDER_IDS,
  REQUIREMENT_ID,
  SCHEMA_VERSION,
} from "./types.js";

export interface SessionExport {
  basename: string;
  markdown: string;
  jsonl: string;
}

export type ParseResult =
  | { ok: true; session: Session }
  | { ok: false; errors: string[] };

export function exportSession(session: Session): SessionExport {
  return {
    basename: `${session.requirementId}-${session.id}`,
    markdown: sessionToMarkdown(session),
    jsonl: sessionToJsonl(session),
  };
}

export function sessionToJsonl(session: Session): string {
  const header = {
    type: "session",
    schemaVersion: session.schemaVersion,
    requirementId: session.requirementId,
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    maxRounds: session.maxRounds,
  };
  const lines = [JSON.stringify(header)];
  for (const message of session.messages) {
    lines.push(JSON.stringify({ type: "message", ...serializeMessage(message) }));
  }
  return `${lines.join("\n")}\n`;
}

export function sessionToMarkdown(session: Session): string {
  const lines: string[] = [
    `# ${session.title}`,
    "",
    `- 需求: ${session.requirementId}`,
    `- 会话: ${session.id}`,
    `- 轮次上限: ${session.maxRounds}`,
    "- 说明: 本文件是可读副本。恢复会话请使用同一次导出的 JSONL。导入后的记录一律视为未验证本地数据。",
    "",
  ];
  for (const message of session.messages) {
    lines.push(`## ${heading(message)}`, "");
    if (message.role === "user" || message.body) {
      lines.push(message.body, "");
    }
    if (message.errorMessage) {
      lines.push(`说明: ${message.errorMessage}`, "");
    }
    if (message.provenance.length > 0) {
      lines.push("注入来源:");
      for (const item of message.provenance) {
        lines.push(`- ${item.providerId} 第 ${item.round} 轮 ${item.phase} message:${item.messageId}`);
      }
      lines.push("");
    }
    lines.push(`记录属性: source=${message.sourceKind}; status=${message.status}; trust=${message.trust}`, "");
  }
  if (!session.messages.some(isInjectableOpinion)) {
    lines.push("当前没有可注入的已完成观点。未接入、失败和超时不是模型回答。", "");
  }
  return lines.join("\n");
}

export function parseSessionJsonl(text: string): ParseResult {
  if (typeof text !== "string") {
    return { ok: false, errors: ["导入内容不是字符串"] };
  }
  if (text.length === 0) {
    return { ok: false, errors: ["导入内容为空"] };
  }
  if (text.length > MAX_IMPORT_CHARS) {
    return { ok: false, errors: [`导入内容超过 ${MAX_IMPORT_CHARS} 字符`] };
  }
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return { ok: false, errors: ["导入内容为空"] };
  }
  if (lines.length > MAX_MESSAGES + 1) {
    return { ok: false, errors: [`记录条数超过 ${MAX_MESSAGES}`] };
  }

  const errors: string[] = [];
  const headerRaw = parseLine(lines[0] ?? "", 1, errors);
  if (!headerRaw || headerRaw.type !== "session") {
    errors.push("第 1 行必须是 session 记录");
    return { ok: false, errors };
  }
  const header = readSessionHeader(headerRaw, errors);
  if (!header) {
    return { ok: false, errors };
  }

  const messages: SessionMessage[] = [];
  const ids = new Set<string>();
  for (let index = 1; index < lines.length; index += 1) {
    const raw = parseLine(lines[index] ?? "", index + 1, errors);
    if (!raw) {
      continue;
    }
    if (raw.type !== "message") {
      errors.push(`第 ${index + 1} 行 type 必须是 message`);
      continue;
    }
    const message = readMessage(raw, header.id, index + 1, errors);
    if (!message) {
      continue;
    }
    if (ids.has(message.id)) {
      errors.push(`第 ${index + 1} 行重复 message id: ${message.id}`);
      continue;
    }
    ids.add(message.id);
    messages.push(message);
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    session: {
      ...header,
      messages,
    },
  };
}

function heading(message: SessionMessage): string {
  const who = message.providerId ? providerLabel(message.providerId) : "用户";
  const phase = message.phase === "independent" ? "独立回答" : "交叉讨论";
  return `第 ${message.round} 轮 · ${phase} · ${who} · ${outcomeHeadline(message)}`;
}

function serializeMessage(message: SessionMessage): Record<string, unknown> {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: message.id,
    sessionId: message.sessionId,
    providerId: message.providerId,
    role: message.role,
    round: message.round,
    phase: message.phase,
    body: message.body,
    createdAt: message.createdAt,
    status: message.status,
    sourceKind: message.sourceKind,
    adapterMode: message.adapterMode,
    provenance: message.provenance,
    errorCode: message.errorCode,
    errorMessage: message.errorMessage,
  };
}

function parseLine(line: string, lineNumber: number, errors: string[]): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      errors.push(`第 ${lineNumber} 行不是 JSON 对象`);
      return null;
    }
    const unsafe = unsafeObjectReason(value, 0);
    if (unsafe) {
      errors.push(`第 ${lineNumber} 行${unsafe}`);
      return null;
    }
    return value as Record<string, unknown>;
  } catch {
    errors.push(`第 ${lineNumber} 行不是合法 JSON`);
    return null;
  }
}

function unsafeObjectReason(value: unknown, depth: number): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  if (depth > 6) {
    return "嵌套过深";
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const reason = unsafeObjectReason(item, depth + 1);
      if (reason) {
        return reason;
      }
    }
    return null;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    return "对象原型不可信";
  }
  for (const key of Object.keys(value)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      return "含有不允许的键名";
    }
    const reason = unsafeObjectReason((value as Record<string, unknown>)[key], depth + 1);
    if (reason) {
      return reason;
    }
  }
  return null;
}

function readSessionHeader(raw: Record<string, unknown>, errors: string[]): Omit<Session, "messages"> | null {
  const schemaVersion = raw.schemaVersion;
  const requirementId = raw.requirementId;
  const id = raw.id;
  const title = raw.title;
  const createdAt = raw.createdAt;
  const updatedAt = raw.updatedAt;
  const maxRounds = raw.maxRounds;
  if (schemaVersion !== SCHEMA_VERSION) {
    errors.push(`不支持的 schemaVersion: ${String(schemaVersion)}`);
  }
  if (requirementId !== REQUIREMENT_ID) {
    errors.push(`requirementId 必须是 ${REQUIREMENT_ID}`);
  }
  if (!isShortString(id, 80)) {
    errors.push("session id 无效");
  }
  if (!isShortString(title, 80)) {
    errors.push("session title 无效");
  }
  if (!isShortString(createdAt, 40) || !isShortString(updatedAt, 40)) {
    errors.push("session 时间无效");
  }
  if (
    typeof maxRounds !== "number" ||
    !Number.isInteger(maxRounds) ||
    maxRounds < 1 ||
    maxRounds > MAX_ALLOWED_ROUNDS
  ) {
    errors.push("maxRounds 无效");
  }
  if (errors.length > 0 || typeof id !== "string" || typeof title !== "string") {
    return null;
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    requirementId: REQUIREMENT_ID,
    id,
    title,
    createdAt: String(createdAt),
    updatedAt: String(updatedAt),
    maxRounds: Number(maxRounds),
  };
}

function readMessage(
  raw: Record<string, unknown>,
  sessionId: string,
  lineNumber: number,
  errors: string[],
): SessionMessage | null {
  const before = errors.length;
  const id = expectString(raw.id, lineNumber, "id", 80, errors);
  const messageSessionId = expectString(raw.sessionId, lineNumber, "sessionId", 80, errors);
  const role = expectEnum(raw.role, ["user", "assistant", "system"] as const, lineNumber, "role", errors);
  const phase = expectEnum(raw.phase, ["independent", "cross_review"] as const, lineNumber, "phase", errors);
  const status = expectEnum(
    raw.status,
    ["complete", "failed", "timeout", "not_connected", "cancelled"] as const,
    lineNumber,
    "status",
    errors,
  );
  const sourceKind = expectEnum(
    raw.sourceKind,
    ["user", "mock", "provider", "system"] as const,
    lineNumber,
    "sourceKind",
    errors,
  );
  const adapterMode = expectEnum(
    raw.adapterMode,
    ["mock", "unimplemented", "none"] as const,
    lineNumber,
    "adapterMode",
    errors,
  );
  const body = expectString(raw.body, lineNumber, "body", MAX_MESSAGE_BODY_CHARS, errors);
  const createdAt = expectString(raw.createdAt, lineNumber, "createdAt", 40, errors);
  const providerId = expectProvider(raw.providerId, lineNumber, errors);
  const errorCode = expectNullableString(raw.errorCode, lineNumber, "errorCode", 80, errors);
  const errorMessage = expectNullableString(raw.errorMessage, lineNumber, "errorMessage", 500, errors);
  const provenance = expectProvenance(raw.provenance, lineNumber, errors);
  const round = raw.round;
  if (typeof round !== "number" || !Number.isInteger(round) || round < 1 || round > MAX_ALLOWED_ROUNDS) {
    errors.push(`第 ${lineNumber} 行 round 无效`);
  }
  if (messageSessionId && messageSessionId !== sessionId) {
    errors.push(`第 ${lineNumber} 行 sessionId 与会话不一致`);
  }
  if (errors.length > before) {
    return null;
  }
  const message: SessionMessage = {
    id: id ?? "",
    sessionId,
    providerId,
    role: role ?? "system",
    round: Number(round),
    phase: phase ?? "independent",
    body: body ?? "",
    createdAt: createdAt ?? "",
    status: status ?? "failed",
    sourceKind: sourceKind ?? "system",
    adapterMode: adapterMode ?? "none",
    provenance,
    errorCode,
    errorMessage,
    trust: "local_unverified_import" satisfies Trust,
  };
  const consistency = consistencyError(message);
  if (consistency) {
    errors.push(`第 ${lineNumber} 行 ${consistency}`);
    return null;
  }
  return message;
}

function consistencyError(message: SessionMessage): string | null {
  if (message.sourceKind === "user") {
    if (message.role !== "user" || message.providerId !== null || message.adapterMode !== "none") {
      return "用户记录字段不一致";
    }
  }
  if (message.sourceKind === "mock") {
    if (message.adapterMode !== "mock") {
      return "mock 记录的 adapterMode 必须是 mock";
    }
    if (message.status === "complete" && !message.body.startsWith("[MOCK]")) {
      return "导入的 MOCK 完成记录必须以 [MOCK] 开头";
    }
  }
  if (message.sourceKind === "provider" && message.adapterMode === "mock") {
    return "provider 记录不能标成 mock";
  }
  if (message.sourceKind === "system" && message.role === "assistant" && message.status === "complete") {
    return "system 记录不能伪装成完成的回答";
  }
  if (message.adapterMode === "unimplemented" && message.status === "complete") {
    return "未接入记录不能是 complete";
  }
  if (message.role === "assistant" && message.providerId === null) {
    return "回答必须带 providerId";
  }
  return null;
}

function expectProvenance(value: unknown, lineNumber: number, errors: string[]): Provenance[] {
  if (!Array.isArray(value)) {
    errors.push(`第 ${lineNumber} 行 provenance 必须是数组`);
    return [];
  }
  if (value.length > 20) {
    errors.push(`第 ${lineNumber} 行 provenance 过多`);
    return [];
  }
  const items: Provenance[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`第 ${lineNumber} 行 provenance 项无效`);
      continue;
    }
    const record = entry as Record<string, unknown>;
    const providerId = record.providerId;
    const phase = record.phase;
    const messageId = record.messageId;
    const round = record.round;
    if (!isProviderId(providerId) || (phase !== "independent" && phase !== "cross_review")) {
      errors.push(`第 ${lineNumber} 行 provenance 来源无效`);
      continue;
    }
    if (typeof messageId !== "string" || messageId.length === 0 || messageId.length > 80) {
      errors.push(`第 ${lineNumber} 行 provenance messageId 无效`);
      continue;
    }
    if (typeof round !== "number" || !Number.isInteger(round) || round < 1 || round > MAX_ALLOWED_ROUNDS) {
      errors.push(`第 ${lineNumber} 行 provenance round 无效`);
      continue;
    }
    items.push({ providerId, phase, messageId, round });
  }
  return items;
}

function expectProvider(value: unknown, lineNumber: number, errors: string[]): ProviderId | null {
  if (value === null) {
    return null;
  }
  if (!isProviderId(value)) {
    errors.push(`第 ${lineNumber} 行 providerId 无效`);
    return null;
  }
  return value;
}

function expectString(
  value: unknown,
  lineNumber: number,
  field: string,
  max: number,
  errors: string[],
): string | null {
  if (typeof value !== "string" || value.length > max) {
    errors.push(`第 ${lineNumber} 行 ${field} 无效`);
    return null;
  }
  return value;
}

function expectNullableString(
  value: unknown,
  lineNumber: number,
  field: string,
  max: number,
  errors: string[],
): string | null {
  if (value === null) {
    return null;
  }
  return expectString(value, lineNumber, field, max, errors);
}

function expectEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  lineNumber: number,
  field: string,
  errors: string[],
): T | null {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    errors.push(`第 ${lineNumber} 行 ${field} 无效`);
    return null;
  }
  return value as T;
}

function isProviderId(value: unknown): value is ProviderId {
  return typeof value === "string" && (PROVIDER_IDS as readonly string[]).includes(value);
}

function isShortString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}
