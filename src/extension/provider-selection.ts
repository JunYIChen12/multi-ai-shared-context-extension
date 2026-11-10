import { PROVIDER_IDS, type ProviderId } from "../core/types.js";

export function providerIdsForMode(
  mode: "mock" | "unimplemented" | "live",
  checked: readonly ProviderId[],
  connected: ProviderId = "chatgpt",
): ProviderId[] {
  if (mode === "mock") return [...PROVIDER_IDS];
  if (mode === "live") return checked.includes(connected) ? [connected] : [];
  return [...checked];
}
