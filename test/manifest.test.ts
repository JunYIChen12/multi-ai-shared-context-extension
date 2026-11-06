import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, readFileSync as readText } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { extensionManifestErrors } from "../src/core/manifest-policy.js";

const root = path.resolve(import.meta.dirname, "..");

describe("扩展壳边界", () => {
  it("manifest 只申请 activeTab 和 scripting，且不声明站点权限", () => {
    const manifest = JSON.parse(readFileSync(path.join(root, "extension/manifest.json"), "utf8")) as {
      permissions?: string[];
      host_permissions?: string[];
    };
    assert.deepEqual(manifest.permissions, ["activeTab", "scripting"]);
    assert.deepEqual(manifest.host_permissions, []);
    assert.deepEqual(extensionManifestErrors(manifest), []);
    const unsafe = {
      manifest_version: 3,
      description: "未接入",
      action: { default_popup: "popup.html" },
      permissions: ["cookies"],
      host_permissions: ["<all_urls>"],
      content_scripts: [],
    };
    const errors = extensionManifestErrors(unsafe);
    assert.equal(errors.some((error) => error.includes("cookies")), true);
    assert.equal(errors.some((error) => error.includes("<all_urls>")), true);
    assert.equal(errors.some((error) => error.includes("content_scripts")), true);

    const missing = {
      manifest_version: 3,
      description: "ChatGPT 临时连接；Grok、Gemini 未接入",
      action: { default_popup: "popup.html" },
      permissions: ["activeTab"],
      host_permissions: [],
    };
    assert.equal(extensionManifestErrors(missing).some((error) => error.includes("scripting")), true);
  });

  it("核心库不依赖 Chrome，扩展页面不把文本当 HTML", () => {
    const coreDir = path.join(root, "src/core");
    for (const file of readdirSync(coreDir)) {
      const source = readText(path.join(coreDir, file), "utf8");
      assert.equal(/chrome\.|document\.cookie|chrome\.cookies/.test(source), false, file);
    }
    const extensionDir = path.join(root, "src/extension");
    for (const file of readdirSync(extensionDir)) {
      const source = readText(path.join(extensionDir, file), "utf8");
      assert.equal(/innerHTML|document\.cookie|chrome\.cookies|eval\(/.test(source), false, file);
    }
  });

  it("构建按需注入的 ChatGPT 内容脚本且不声明常驻内容脚本", () => {
    const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/build.ts"], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.doesNotThrow(() => readFileSync(path.join(root, "dist/extension/chatgpt-content.js")));

    const manifest = JSON.parse(readFileSync(path.join(root, "dist/extension/manifest.json"), "utf8")) as {
      content_scripts?: unknown;
    };
    assert.equal(manifest.content_scripts, undefined);
  });
});
