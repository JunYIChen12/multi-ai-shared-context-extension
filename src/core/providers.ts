import { mockBody, notConnectedDetail } from "./labels.js";
import type { ProviderAdapter, ProviderId, ProviderResponse } from "./types.js";

export function unimplementedAdapter(id: ProviderId): ProviderAdapter {
  return {
    id,
    mode: "unimplemented",
    async respond(): Promise<ProviderResponse> {
      return {
        mode: "unimplemented",
        status: "not_connected",
        body: "",
        error: { code: "not_connected", message: notConnectedDetail(id) },
      };
    },
  };
}

export function mockAdapter(id: ProviderId): ProviderAdapter {
  return {
    id,
    mode: "mock",
    async respond(request): Promise<ProviderResponse> {
      return {
        mode: "mock",
        status: "complete",
        body: mockBody(id, request.phase, request.injection.length),
      };
    },
  };
}

export function defaultAdapters(): ProviderAdapter[] {
  return [
    unimplementedAdapter("chatgpt"),
    unimplementedAdapter("grok"),
    unimplementedAdapter("gemini"),
  ];
}

export function mockAdapters(): ProviderAdapter[] {
  return [mockAdapter("chatgpt"), mockAdapter("grok"), mockAdapter("gemini")];
}

export function adaptersById(adapters: ProviderAdapter[]): Map<ProviderId, ProviderAdapter> {
  const map = new Map<ProviderId, ProviderAdapter>();
  for (const adapter of adapters) {
    if (map.has(adapter.id)) {
      throw new Error(`重复的 provider 适配器: ${adapter.id}`);
    }
    map.set(adapter.id, adapter);
  }
  return map;
}
