import { spawnSync } from "node:child_process";
import { cp, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import * as esbuild from "esbuild";
import { assertExtensionManifestSafe } from "../src/core/manifest-policy.js";

const root = path.resolve(import.meta.dirname, "..");
const outdir = path.join(root, "dist", "extension");

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

await esbuild.build({
  entryPoints: {
    popup: path.join(root, "src/extension/popup.ts"),
    discussion: path.join(root, "src/extension/discussion.ts"),
    "chatgpt-content": path.join(root, "src/extension/chatgpt-content.ts"),
    "gemini-content": path.join(root, "src/extension/gemini-content.ts"),
  },
  bundle: true,
  outdir,
  format: "iife",
  platform: "browser",
  target: "chrome120",
  legalComments: "none",
  logLevel: "info",
});

await cp(path.join(root, "extension"), outdir, { recursive: true });

const required = [
  "manifest.json",
  "popup.html",
  "popup.js",
  "discussion.html",
  "discussion.js",
  "discussion.css",
  "chatgpt-content.js",
  "gemini-content.js",
];
for (const name of required) {
  await readFile(path.join(outdir, name));
}

const manifestText = await readFile(path.join(outdir, "manifest.json"), "utf8");
const manifest: unknown = JSON.parse(manifestText);
assertExtensionManifestSafe(manifest);

const popupHtml = await readFile(path.join(outdir, "popup.html"), "utf8");
const discussionHtml = await readFile(path.join(outdir, "discussion.html"), "utf8");
assertLocalPage(popupHtml, "popup.html");
assertLocalPage(discussionHtml, "discussion.html");
if (!popupHtml.includes('src="popup.js"')) {
  throw new Error("popup.html 没有引用 popup.js");
}
if (!discussionHtml.includes('src="discussion.js"') || !discussionHtml.includes('href="discussion.css"')) {
  throw new Error("discussion.html 的脚本或样式引用不正确");
}

syntaxCheck(path.join(outdir, "popup.js"));
syntaxCheck(path.join(outdir, "discussion.js"));
syntaxCheck(path.join(outdir, "chatgpt-content.js"));
syntaxCheck(path.join(outdir, "gemini-content.js"));

console.log(`built ${path.relative(root, outdir)}`);

function assertLocalPage(html: string, filename: string): void {
  if (/<script[^>]+src=["']https?:/i.test(html) || /url\(["']?https?:/i.test(html)) {
    throw new Error(`${filename} 引用了远程资源`);
  }
  if (/innerHTML|document\.cookie|chrome\.cookies/i.test(html)) {
    throw new Error(`${filename} 含有不允许的页面脚本`);
  }
}

function syntaxCheck(file: string): void {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || `语法检查失败: ${file}`);
  }
}
