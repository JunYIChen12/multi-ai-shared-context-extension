import { MAX_MESSAGE_BODY_CHARS } from "../core/types.js";

/**
 * 页面证据契约。
 * 离线测试证明的是这份契约下的判定，不是当前 ChatGPT DOM 已经提供这些字段。
 * 读不到、冲突或无法证明时必须未知，不能退回全页计数或最后一个节点。
 */

export type ReadState<T> = { state: "unreadable" } | { state: "ready"; value: T };

export interface StructuralTurn {
  id: string;
  role: "user" | "assistant";
  order: number;
  /** 只有调用方点名要读的轮次才允许带正文。基线不得预读旧聊天正文。 */
  text?: string;
  endControl: ReadState<true>;
}

export type SessionIdentity =
  | { state: "unreadable" }
  | { state: "ready"; kind: "draft" }
  | { state: "ready"; kind: "conversation"; id: string }
  | { state: "ready"; kind: "provisional"; token: string }
  | { state: "ready"; kind: "unrecognized" };

export interface PageEvidence {
  session: SessionIdentity;
  turns: ReadState<StructuralTurn[]>;
  composerStop: ReadState<boolean>;
  pageError: ReadState<"none" | "present">;
}

export interface ChatGptEvidencePort {
  read(request: { textTurnIds: readonly string[] }): PageEvidence;
  writePrompt(prompt: string): boolean;
  submit(): boolean;
  watchStop(onStop: () => void): () => void;
}

export type TerminalCode =
  | "unknown"
  | "stopped"
  | "navigation"
  | "page_error"
  | "empty_response"
  | "response_too_large"
  | "busy";

export interface CollectionMemory {
  baselineTurnIds: ReadonlySet<string>;
  baselineSession: SessionIdentity;
  bornOnDraftUserId: string | null;
  provisionalToken: string | null;
  stopClicked: boolean;
  attributedUserId: string | null;
  attributedAssistantId: string | null;
  lastText: string;
  stableReads: number;
  stableNeeded: number;
  sawEmptyReady: boolean;
}

export type PollAssessment =
  | { kind: "pending"; memory: CollectionMemory }
  | { kind: "terminal"; code: TerminalCode; message: string }
  | { kind: "success"; body: string };

const MESSAGES = {
  busy: "ChatGPT 页面仍在生成，请等待完成后重试",
  baselineStop: "发送前读不到生成控件，不能建立基线",
  baselineTurns: "发送前读不到轮次结构，不能建立基线",
  baselineSession: "发送前不能确认会话身份",
  baselineError: "发送前读不到错误标记，不能建立基线",
  baselineDuplicate: "基线里的轮次身份重复",
  pageError: "页面出现错误标记",
  stopped: "已观察到本轮停止动作，残留文本不算正常结束",
  unreadable: "页面结构或会话证据不可读",
  unrecognized: "会话地址无法套用连续性规则",
  provisionalConflict: "临时会话地址发生冲突，不能确定连续性",
  switched: "会话身份已切换，停止接收新页面内容",
  unproven: "无法证明新聊天地址仍是本次发送",
  manyUsers: "出现多个新的用户轮次，不能确定归属",
  userConflict: "本次用户轮次身份发生冲突",
  manyAssistants: "本次用户轮次对应到多个新回复",
  assistantConflict: "本次回复身份发生冲突",
  assistantLost: "已归属的回复节点不再可观察",
  duplicateIds: "轮次身份重复，不能确定归属",
  tooLarge: "ChatGPT 回复超过本地记录上限",
  empty: "本次回复已有结束信号但正文为空",
  deadline: "观察结束时仍没有充分的归属和自然结束证据",
  ambiguous: "还有未对应的发送，不能确定新轮次属于本次",
} as const;

export function parseSessionUrl(raw: string): SessionIdentity {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { state: "unreadable" };
  }
  if (url.protocol !== "https:" || url.hostname !== "chatgpt.com") {
    return { state: "unreadable" };
  }
  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (path === "/") {
    return { state: "ready", kind: "draft" };
  }
  const conversation = /^\/c\/([A-Za-z0-9_-]+)$/.exec(path);
  if (conversation?.[1]) {
    return { state: "ready", kind: "conversation", id: conversation[1] };
  }
  const provisional = /^\/c\/local-chatgpt%3[aA]([A-Za-z0-9_-]{1,200})$/.exec(path);
  if (provisional?.[1]) {
    return { state: "ready", kind: "provisional", token: provisional[1] };
  }
  return { state: "ready", kind: "unrecognized" };
}

export function relateSession(
  pinned: SessionIdentity,
  current: SessionIdentity,
  bornOnDraftUserId: string | null,
  turns: readonly StructuralTurn[],
): "same" | "extended" | "switched" | "unproven" {
  if (pinned.state !== "ready" || current.state !== "ready") {
    return "unproven";
  }
  if (pinned.kind === "unrecognized" || current.kind === "unrecognized") {
    return "unproven";
  }
  if (pinned.kind === "draft" && current.kind === "draft") {
    return "same";
  }
  if (pinned.kind === "conversation" && current.kind === "conversation") {
    return pinned.id === current.id ? "same" : "switched";
  }
  if (pinned.kind === "conversation" && current.kind === "draft") {
    return "switched";
  }
  if (pinned.kind === "draft" && current.kind === "conversation") {
    const stillThere = Boolean(
      bornOnDraftUserId && turns.some((turn) => turn.role === "user" && turn.id === bornOnDraftUserId),
    );
    return stillThere ? "extended" : "unproven";
  }
  return "unproven";
}

export function assessBaseline(evidence: PageEvidence): { code: TerminalCode; message: string } | null {
  if (evidence.pageError.state === "ready" && evidence.pageError.value === "present") {
    return { code: "page_error", message: MESSAGES.pageError };
  }
  if (evidence.composerStop.state === "unreadable") {
    return { code: "unknown", message: MESSAGES.baselineStop };
  }
  if (evidence.composerStop.state === "ready" && evidence.composerStop.value) {
    return { code: "busy", message: MESSAGES.busy };
  }
  if (evidence.turns.state === "unreadable") {
    return { code: "unknown", message: MESSAGES.baselineTurns };
  }
  if (hasDuplicateIds(evidence.turns.value)) {
    return { code: "unknown", message: MESSAGES.baselineDuplicate };
  }
  if (evidence.session.state !== "ready"
    || evidence.session.kind === "unrecognized"
    || evidence.session.kind === "provisional") {
    return { code: "unknown", message: MESSAGES.baselineSession };
  }
  if (evidence.pageError.state === "unreadable") {
    return { code: "unknown", message: MESSAGES.baselineError };
  }
  return null;
}

export function memoryFromBaseline(evidence: PageEvidence, stableChecks: number): CollectionMemory {
  const turns = evidence.turns.state === "ready" ? evidence.turns.value : [];
  return {
    baselineTurnIds: new Set(turns.map((turn) => turn.id)),
    baselineSession: evidence.session,
    bornOnDraftUserId: null,
    provisionalToken: null,
    stopClicked: false,
    attributedUserId: null,
    attributedAssistantId: null,
    lastText: "",
    stableReads: 0,
    stableNeeded: stableChecks,
    sawEmptyReady: false,
  };
}

export function assessPoll(
  memory: CollectionMemory,
  evidence: PageEvidence,
  stopClicked: boolean,
  requestedTextIds: readonly string[],
  canAttribute: boolean,
): PollAssessment {
  const clicked = memory.stopClicked || stopClicked;
  if (clicked) {
    return terminal("stopped", MESSAGES.stopped);
  }
  if (evidence.pageError.state === "ready" && evidence.pageError.value === "present") {
    return terminal("page_error", MESSAGES.pageError);
  }
  if (evidence.turns.state !== "ready" || evidence.session.state !== "ready") {
    return terminal("unknown", MESSAGES.unreadable);
  }
  if (evidence.session.kind === "unrecognized") {
    return terminal("unknown", MESSAGES.unrecognized);
  }
  if (hasDuplicateIds(evidence.turns.value)) {
    return terminal("unknown", MESSAGES.duplicateIds);
  }
  if (evidence.session.kind === "provisional") {
    if (memory.baselineSession.state !== "ready" || memory.baselineSession.kind !== "draft") {
      return terminal("navigation", MESSAGES.switched);
    }
    if (memory.provisionalToken && memory.provisionalToken !== evidence.session.token) {
      return terminal("unknown", MESSAGES.provisionalConflict);
    }
    const newUsers = evidence.turns.value.filter((turn) => turn.role === "user" && !memory.baselineTurnIds.has(turn.id));
    if (newUsers.length > 1) {
      return terminal("unknown", MESSAGES.manyUsers);
    }
    if (memory.attributedUserId && newUsers.some((turn) => turn.id !== memory.attributedUserId)) {
      return terminal("unknown", MESSAGES.userConflict);
    }
    if (memory.attributedUserId) {
      const linked = linkedAssistant(evidence.turns.value, memory.attributedUserId, memory.baselineTurnIds);
      if (linked === "conflict") {
        return terminal("unknown", MESSAGES.manyAssistants);
      }
      if (linked !== "none" && memory.attributedAssistantId && linked.id !== memory.attributedAssistantId) {
        return terminal("unknown", MESSAGES.assistantConflict);
      }
    }
    return { kind: "pending", memory: {
      ...memory, provisionalToken: evidence.session.token, lastText: "", stableReads: 0, sawEmptyReady: false,
    } };
  }

  const turns = evidence.turns.value;
  const newUsers = turns.filter((turn) => turn.role === "user" && !memory.baselineTurnIds.has(turn.id));
  let bornOnDraftUserId = memory.bornOnDraftUserId;
  const onDraft = memory.baselineSession.state === "ready"
    && memory.baselineSession.kind === "draft"
    && evidence.session.kind === "draft";
  if (onDraft && newUsers.length === 1 && canAttribute) {
    const id = newUsers[0]?.id ?? null;
    if (id && !bornOnDraftUserId) {
      bornOnDraftUserId = id;
    }
  }
  const continuity = relateSession(memory.baselineSession, evidence.session, bornOnDraftUserId, turns);
  if (continuity === "switched") {
    return terminal("navigation", MESSAGES.switched);
  }
  if (continuity === "unproven") {
    return terminal("unknown", MESSAGES.unproven);
  }
  const pinnedSession = continuity === "extended" ? evidence.session : memory.baselineSession;
  if (newUsers.length > 1) {
    return terminal("unknown", MESSAGES.manyUsers);
  }
  if (newUsers.length === 1 && !canAttribute) {
    return terminal("unknown", MESSAGES.ambiguous);
  }

  let userId = memory.attributedUserId;
  if (newUsers.length === 1) {
    const id = newUsers[0]?.id ?? null;
    if (!id) {
      return terminal("unknown", MESSAGES.unreadable);
    }
    if (userId && userId !== id) {
      return terminal("unknown", MESSAGES.userConflict);
    }
    userId = id;
  }

  let assistantId = memory.attributedAssistantId;
  if (userId) {
    const linked = linkedAssistant(turns, userId, memory.baselineTurnIds);
    if (linked === "conflict") {
      return terminal("unknown", MESSAGES.manyAssistants);
    }
    if (linked !== "none") {
      if (assistantId && assistantId !== linked.id) {
        return terminal("unknown", MESSAGES.assistantConflict);
      }
      assistantId = linked.id;
    } else if (assistantId) {
      return terminal("unknown", MESSAGES.assistantLost);
    }
  }

  const next: CollectionMemory = {
    ...memory,
    baselineSession: pinnedSession,
    bornOnDraftUserId,
    stopClicked: false,
    attributedUserId: userId,
    attributedAssistantId: assistantId,
    lastText: "",
    stableReads: 0,
    sawEmptyReady: memory.sawEmptyReady,
  };
  if (!userId || !assistantId) {
    return { kind: "pending", memory: next };
  }

  const assistant = turns.find((turn) => turn.id === assistantId && turn.role === "assistant");
  if (!assistant) {
    return terminal("unknown", MESSAGES.assistantLost);
  }

  const requested = requestedTextIds.includes(assistantId);
  const text = requested ? (assistant.text ?? "").trim() : "";
  const endReady = assistant.endControl.state === "ready";
  const stopIdle = evidence.composerStop.state === "ready" && evidence.composerStop.value === false;
  const errorClear = evidence.pageError.state === "ready" && evidence.pageError.value === "none";
  const shellReady = endReady && stopIdle && errorClear;
  if (!requested || !shellReady) {
    return { kind: "pending", memory: { ...next, sawEmptyReady: false } };
  }
  if (!text) {
    return { kind: "pending", memory: { ...next, sawEmptyReady: true } };
  }
  if (text.length > MAX_MESSAGE_BODY_CHARS) {
    return terminal("response_too_large", MESSAGES.tooLarge);
  }

  const stableReads = text === memory.lastText ? memory.stableReads + 1 : 1;
  if (stableReads >= memory.stableNeeded) {
    return { kind: "success", body: text };
  }
  return {
    kind: "pending",
    memory: { ...next, lastText: text, stableReads, sawEmptyReady: false },
  };
}

export function deadlineResult(memory: CollectionMemory): { code: TerminalCode; message: string } {
  if (memory.stopClicked) {
    return { code: "stopped", message: MESSAGES.stopped };
  }
  if (memory.sawEmptyReady) {
    return { code: "empty_response", message: MESSAGES.empty };
  }
  return { code: "unknown", message: MESSAGES.deadline };
}

function terminal(code: TerminalCode, message: string): PollAssessment {
  return { kind: "terminal", code, message };
}

function linkedAssistant(
  turns: readonly StructuralTurn[],
  userId: string,
  baselineTurnIds: ReadonlySet<string>,
): StructuralTurn | "none" | "conflict" {
  const sorted = [...turns].sort((left, right) => left.order - right.order);
  const start = sorted.findIndex((turn) => turn.id === userId && turn.role === "user");
  if (start < 0) {
    return "none";
  }
  const found: StructuralTurn[] = [];
  for (let index = start + 1; index < sorted.length; index += 1) {
    const turn = sorted[index];
    if (!turn || turn.role === "user") {
      break;
    }
    if (!baselineTurnIds.has(turn.id)) {
      found.push(turn);
    }
  }
  if (found.length === 0) {
    return "none";
  }
  if (found.length > 1) {
    return "conflict";
  }
  return found[0] ?? "none";
}

function hasDuplicateIds(turns: readonly StructuralTurn[]): boolean {
  const seen = new Set<string>();
  for (const turn of turns) {
    if (seen.has(turn.id)) {
      return true;
    }
    seen.add(turn.id);
  }
  return false;
}
