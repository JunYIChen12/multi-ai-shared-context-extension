export type ConnectedProviderId = "chatgpt" | "gemini";

export interface DiscussionContext {
  contextType: string;
  documentUrl?: string;
  tabId: number;
  incognito: boolean;
}

export type DiscussionDestination =
  | { kind: "none" }
  | { kind: "unique"; tabId: number }
  | { kind: "ambiguous" };

export interface ConnectionRequest {
  channel: "multi-ai-discussion-connect-v1";
  targetDiscussionTabId: number;
  providerId: ConnectedProviderId;
  providerTabId: number;
}

export type ConnectedTabIds = Partial<Record<ConnectedProviderId, number>>;

export const CONNECTION_REJECTION_CODES = [
  "INVALID_REQUEST", "INVALID_SENDER", "DISCUSSION_TAB_MISSING", "TARGET_TAB_MISMATCH",
  "TARGET_NOT_UNIQUE", "CONTEXT_LOOKUP_FAILED", "PROVIDER_TAB_LOOKUP_FAILED",
  "PROVIDER_TAB_NOT_READY", "INCOGNITO_MISMATCH", "PROVIDER_ALREADY_CONNECTED",
  "TAB_ALREADY_CONNECTED", "ACK_INVALID",
] as const;
export type ConnectionRejectionCode = typeof CONNECTION_REJECTION_CODES[number];

export function findDiscussionDestination(
  contexts: readonly DiscussionContext[],
  discussionUrl: string,
  incognito: boolean,
): DiscussionDestination {
  const target = new URL(discussionUrl);
  const tabIds = new Set<number>();
  for (const context of contexts) {
    if (context.contextType !== "TAB" || context.incognito !== incognito || !isTabId(context.tabId)) continue;
    if (!context.documentUrl) continue;
    try {
      const url = new URL(context.documentUrl);
      if (
        url.protocol === target.protocol &&
        url.hostname === target.hostname &&
        url.port === target.port &&
        url.pathname === target.pathname
      ) tabIds.add(context.tabId);
    } catch {
      continue;
    }
  }
  if (tabIds.size === 0) return { kind: "none" };
  if (tabIds.size > 1) return { kind: "ambiguous" };
  return { kind: "unique", tabId: tabIds.values().next().value as number };
}

export function sameDiscussionDestination(left: DiscussionDestination, right: DiscussionDestination): boolean {
  if (left.kind === "none" || right.kind === "none") return left.kind === "none" && right.kind === "none";
  return left.kind === "unique" && right.kind === "unique" && left.tabId === right.tabId;
}

export function createConnectionRequest(
  targetDiscussionTabId: number,
  providerId: ConnectedProviderId,
  providerTabId: number,
): ConnectionRequest {
  if (!isTabId(targetDiscussionTabId) || !isTabId(providerTabId)) throw new Error("连接标签页 ID 无效");
  return { channel: "multi-ai-discussion-connect-v1", targetDiscussionTabId, providerId, providerTabId };
}

export function isConnectionRequest(value: unknown): value is ConnectionRequest {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  return message.channel === "multi-ai-discussion-connect-v1" &&
    isTabId(message.targetDiscussionTabId) &&
    (message.providerId === "chatgpt" || message.providerId === "gemini") &&
    isTabId(message.providerTabId) &&
    Object.keys(message).every((key) => ["channel", "targetDiscussionTabId", "providerId", "providerTabId"].includes(key));
}

export function connectionAckMatches(value: unknown, targetDiscussionTabId: number): boolean {
  return Boolean(
    value &&
    typeof value === "object" &&
    (value as Record<string, unknown>).ok === true &&
    (value as Record<string, unknown>).targetDiscussionTabId === targetDiscussionTabId,
  );
}

export function connectionAckRejectionCode(value: unknown, targetDiscussionTabId: number): ConnectionRejectionCode {
  if (!value || typeof value !== "object") return "ACK_INVALID";
  const response = value as Record<string, unknown>;
  if (response.ok !== false || response.targetDiscussionTabId !== targetDiscussionTabId) return "ACK_INVALID";
  return CONNECTION_REJECTION_CODES.find((code) => code === response.code) ?? "ACK_INVALID";
}

export function connectionRejectionCode(
  request: ConnectionRequest,
  discussionTab: { id?: number; incognito?: boolean } | null,
  destination: DiscussionDestination,
  providerTab: { status?: string; incognito?: boolean } | null,
  connected: ConnectedTabIds,
): ConnectionRejectionCode | null {
  if (!discussionTab?.id) return "DISCUSSION_TAB_MISSING";
  if (discussionTab.id !== request.targetDiscussionTabId) return "TARGET_TAB_MISMATCH";
  if (destination.kind !== "unique" || destination.tabId !== discussionTab.id) return "TARGET_NOT_UNIQUE";
  if (!providerTab) return "PROVIDER_TAB_LOOKUP_FAILED";
  if (providerTab.status !== "complete") return "PROVIDER_TAB_NOT_READY";
  if (providerTab.incognito !== (discussionTab.incognito ?? false)) return "INCOGNITO_MISMATCH";
  if (connected[request.providerId] !== undefined) return "PROVIDER_ALREADY_CONNECTED";
  if (Object.values(connected).includes(request.providerTabId)) return "TAB_ALREADY_CONNECTED";
  return null;
}

export function readConnectedTabIds(search: string): ConnectedTabIds {
  const params = new URLSearchParams(search);
  if (params.has("chatgptTab") && params.has("geminiTab")) return {};
  const connected: ConnectedTabIds = {};
  for (const providerId of ["chatgpt", "gemini"] as const) {
    const values = params.getAll(`${providerId}Tab`);
    if (values.length !== 1 || !/^\d+$/.test(values[0] ?? "")) continue;
    const tabId = Number(values[0]);
    if (isTabId(tabId) && !Object.values(connected).includes(tabId)) connected[providerId] = tabId;
  }
  return Object.keys(connected).length > 1 ? {} : connected;
}

export function canAttachProvider(
  connected: ConnectedTabIds,
  providerId: ConnectedProviderId,
  providerTabId: number,
): boolean {
  return isTabId(providerTabId) && connected[providerId] === undefined && !Object.values(connected).includes(providerTabId);
}

export function providerForTabId(connected: ConnectedTabIds, tabId: number): ConnectedProviderId | null {
  const matches = (["chatgpt", "gemini"] as const).filter((providerId) => connected[providerId] === tabId);
  return matches.length === 1 ? matches[0] ?? null : null;
}

export function shouldDisconnectOnTabUpdate(
  providerId: ConnectedProviderId,
  changeInfo: { status?: string; url?: string },
): boolean {
  if (changeInfo.url !== undefined) {
    try {
      const url = new URL(changeInfo.url);
      const hostname = providerId === "chatgpt" ? "chatgpt.com" : "gemini.google.com";
      return url.protocol !== "https:" || url.hostname !== hostname;
    } catch {
      return true;
    }
  }
  return changeInfo.status === "loading";
}

function isTabId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
