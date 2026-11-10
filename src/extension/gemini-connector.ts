export interface GeminiConnectionPort {
  getActiveTab(): Promise<{ id?: number; url?: string } | null>;
  injectScript(tabId: number, filename: string): Promise<void>;
  openDiscussion(path: string): Promise<void>;
}

export type GeminiConnectionResult =
  | { ok: true }
  | { ok: false; code: "no_active_tab" | "not_gemini" | "connection_failed"; message: string };

export function isGeminiUrl(raw: string | undefined): boolean {
  if (!raw) return false;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && url.hostname === "gemini.google.com" &&
      (url.pathname === "/app" || /^\/(?:u\/\d+\/)?app(?:\/[^/]+)?$/.test(url.pathname));
  } catch {
    return false;
  }
}

export function readGeminiTabId(search: string): number | null {
  const raw = new URLSearchParams(search).get("geminiTab");
  if (!raw || !/^\d+$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export async function connectActiveGeminiTab(port: GeminiConnectionPort): Promise<GeminiConnectionResult> {
  try {
    const tab = await port.getActiveTab();
    if (!tab || !Number.isSafeInteger(tab.id) || (tab.id ?? 0) <= 0) {
      return { ok: false, code: "no_active_tab", message: "没有可连接的当前标签页" };
    }
    if (!isGeminiUrl(tab.url)) {
      return { ok: false, code: "not_gemini", message: "请先打开并登录 https://gemini.google.com/app" };
    }
    await port.injectScript(tab.id as number, "gemini-content.js");
    await port.openDiscussion(`discussion.html?geminiTab=${tab.id}`);
    return { ok: true };
  } catch {
    return { ok: false, code: "connection_failed", message: "无法临时连接 Gemini 标签页，请重试" };
  }
}
