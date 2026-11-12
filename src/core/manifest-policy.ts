export interface ExtensionManifestPolicy {
  manifest_version: number;
  name?: string;
  description?: string;
  action?: { default_popup?: string };
  permissions?: string[];
  host_permissions?: string[];
  optional_permissions?: string[];
  optional_host_permissions?: string[];
  content_scripts?: unknown;
  background?: unknown;
  web_accessible_resources?: unknown;
  externally_connectable?: unknown;
  oauth2?: unknown;
  content_security_policy?: unknown;
  chrome_url_overrides?: unknown;
}

const FORBIDDEN_PERMISSIONS = new Set([
  "cookies",
  "history",
  "tabs",
  "webRequest",
  "webRequestBlocking",
  "debugger",
  "nativeMessaging",
  "proxy",
  "privacy",
  "downloads",
  "identity",
]);

const REQUIRED_PERMISSIONS = new Set(["activeTab", "scripting"]);

/**
 * ChatGPT 单标签页阶段的权限上限。
 * 返回错误列表；空数组表示可以通过。
 * 只允许用户手势触发的临时标签页访问，不声明站点权限。
 */
export function extensionManifestErrors(manifest: unknown): string[] {
  const errors: string[] = [];
  if (!manifest || typeof manifest !== "object") {
    return ["manifest 不是对象"];
  }
  const value = manifest as ExtensionManifestPolicy;
  if (value.manifest_version !== 3) {
    errors.push("manifest_version 必须为 3");
  }
  if (!value.description?.includes("未接入")) {
    errors.push("description 必须明确写明未接入");
  }
  if (value.action?.default_popup !== "popup.html") {
    errors.push("action.default_popup 必须是 popup.html");
  }
  errors.push(...requiredPermissionErrors(value.permissions));
  errors.push(...permissionErrors("optional_permissions", value.optional_permissions));
  errors.push(...hostErrors("host_permissions", value.host_permissions));
  errors.push(...hostErrors("optional_host_permissions", value.optional_host_permissions));
  if (value.content_scripts !== undefined) {
    errors.push("本阶段不允许 content_scripts");
  }
  if (value.background !== undefined) {
    errors.push("本阶段不允许 background service worker");
  }
  if (value.web_accessible_resources !== undefined) {
    errors.push("本阶段不允许 web_accessible_resources");
  }
  if (value.externally_connectable !== undefined) {
    errors.push("本阶段不允许 externally_connectable");
  }
  if (value.oauth2 !== undefined) {
    errors.push("本阶段不允许 oauth2");
  }
  if (value.chrome_url_overrides !== undefined) {
    errors.push("本阶段不允许 chrome_url_overrides");
  }
  if (value.content_security_policy !== undefined) {
    const raw = JSON.stringify(value.content_security_policy);
    if (raw.includes("unsafe-eval") || raw.includes("http:")) {
      errors.push("content_security_policy 放宽了默认限制");
    }
  }
  return errors;
}

export function assertExtensionManifestSafe(manifest: unknown): void {
  const errors = extensionManifestErrors(manifest);
  if (errors.length > 0) {
    throw new Error(errors.join("\n"));
  }
}

function permissionErrors(field: string, permissions: string[] | undefined): string[] {
  if (permissions === undefined) {
    return [];
  }
  if (!Array.isArray(permissions)) {
    return [`${field} 必须是数组`];
  }
  const errors: string[] = [];
  for (const permission of permissions) {
    if (FORBIDDEN_PERMISSIONS.has(permission) || permission.startsWith("<") || permission.includes("://")) {
      errors.push(`${field} 含有本阶段禁止的权限: ${permission}`);
    } else {
      errors.push(`${field} 本阶段必须为空，发现: ${permission}`);
    }
  }
  return errors;
}

function requiredPermissionErrors(permissions: string[] | undefined): string[] {
  if (!Array.isArray(permissions)) {
    return ["permissions 必须是数组"];
  }
  const errors: string[] = [];
  for (const required of REQUIRED_PERMISSIONS) {
    if (!permissions.includes(required)) {
      errors.push(`permissions 缺少批准的权限: ${required}`);
    }
  }
  for (const permission of permissions) {
    if (!REQUIRED_PERMISSIONS.has(permission)) {
      errors.push(`permissions 含有未批准的权限: ${permission}`);
    }
  }
  return errors;
}

function hostErrors(field: string, hosts: string[] | undefined): string[] {
  if (hosts === undefined) {
    return [];
  }
  if (!Array.isArray(hosts)) {
    return [`${field} 必须是数组`];
  }
  if (hosts.length === 0) {
    return [];
  }
  return hosts.map((host) => `${field} 不允许站点权限: ${host}`);
}
