import { PROVIDER_IDS, type ProviderId } from "../core/types.js";
import { isChatGptUrl } from "./chatgpt-connector.js";
import { GEMINI_OUTER_TIMEOUT_MS, isGeminiUrl } from "./gemini-connector.js";
import type { ConnectedProviderId } from "./discussion-routing.js";

export const CHATGPT_OUTER_TIMEOUT_MS = 30_000;

export function providerForTabUrl(rawUrl: string | undefined): ConnectedProviderId | null {
  if (isChatGptUrl(rawUrl)) return "chatgpt";
  if (isGeminiUrl(rawUrl)) return "gemini";
  return null;
}

export function timeoutMsForRound(mode: "mock" | "unimplemented" | "live", connected: ProviderId): number {
  return mode === "live" && connected === "gemini" ? GEMINI_OUTER_TIMEOUT_MS : CHATGPT_OUTER_TIMEOUT_MS;
}

export function providerIdsForMode(
  mode: "mock" | "unimplemented" | "live",
  checked: readonly ProviderId[],
  connected: readonly ConnectedProviderId[] = ["chatgpt"],
): ProviderId[] {
  if (mode === "mock") return [...PROVIDER_IDS];
  if (mode === "live") return checked.filter((id) => id !== "grok" && connected.includes(id));
  return [...checked];
}
