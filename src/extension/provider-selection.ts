import { PROVIDER_IDS, type ProviderId } from "../core/types.js";

export function providerIdsForMode(
  mode: "mock" | "unimplemented" | "live",
  checked: readonly ProviderId[],
): ProviderId[] {
  if (mode === "mock") return [...PROVIDER_IDS];
  if (mode === "live") return checked.includes("chatgpt") ? ["chatgpt"] : [];
  return [...checked];
}
