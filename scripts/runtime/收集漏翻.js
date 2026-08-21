#!/usr/bin/env node
"use strict";

// 导出汉化脚本运行时收集到的漏翻清单。
// 用法：
//   node 收集漏翻.js            输出并保存清单到 _generated/zh-misses.json
//   node 收集漏翻.js --clear    导出后清空已收集记录
// 前提：Postman 以 --remote-debugging-port=0 启动（postman-zh.bat install 默认如此）。

const fs = require("fs");
const path = require("path");
const { sanitizeAuditReport, writeAuditReport } = require("../audit/审计安全.js");
const SHOW_DETAILS = process.argv.includes("--details");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function connectCdp(wsUrl) {
  let nextId = 1;
  const pending = new Map();
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("连接 CDP 超时。")), 10000);
    ws.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("连接 CDP 失败。")); }, { once: true });
  });
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const cb = pending.get(message.id);
    pending.delete(message.id);
    clearTimeout(cb.timer);
    if (message.error) cb.reject(new Error(message.error.message));
    else cb.resolve(message.result);
  });
  return {
    send(method, params = {}) {
      const id = nextId++;
      ws.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (pending.has(id)) { pending.delete(id); reject(new Error(`CDP 方法执行超时：${method}`)); }
        }, 30000);
        pending.set(id, { resolve, reject, timer });
      });
    },
    close() { try { ws.close(); } catch (_) {} }
  };
}

async function main() {
  const clear = process.argv.includes("--clear");
  const portFile = path.join(process.env.APPDATA || "", "Postman", "DevToolsActivePort");
  if (!fs.existsSync(portFile)) {
    throw new Error("找不到 DevToolsActivePort。请先通过 postman-zh.bat start 启动 Postman。");
  }
  const port = fs.readFileSync(portFile, "utf8").split(/\r?\n/)[0].trim();
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const pages = targets.filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
  if (!pages.length) throw new Error("没有找到可调试的 Postman 页面。");

  const merged = new Map();
  for (const page of pages) {
    let cdp;
    try {
      cdp = await connectCdp(page.webSocketDebuggerUrl);
      const result = await cdp.send("Runtime.evaluate", {
        expression: `(() => {
          const L = window.__POSTMAN_ZH_LOCALIZER__;
          if (!L || !L.getMisses) return "[]";
          const list = JSON.stringify(L.getMisses());
          ${clear ? "L.clearMisses();" : ""}
          return list;
        })()`,
        returnByValue: true
      });
      const list = JSON.parse(result.result.value || "[]");
      for (const item of list) {
        const existing = merged.get(item.text);
        if (existing) existing.count += item.count;
        else merged.set(item.text, { ...item });
      }
    } catch (error) {
      if (SHOW_DETAILS) {
        console.error(JSON.stringify(sanitizeAuditReport({ ok: false, url: page.url, error: error && error.message || String(error) })));
      } else {
        console.error("已跳过一个无法读取的 Postman 调试目标。");
      }
    } finally {
      if (cdp) cdp.close();
    }
  }

  const misses = Array.from(merged.values()).sort((a, b) => b.count - a.count || a.text.localeCompare(b.text));
  const outDir = path.resolve(__dirname, "..", "..", "..", "_generated");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, "zh-misses.json");
  const safeMisses = sanitizeAuditReport({ findings: misses }).findings || [];
  writeAuditReport(outFile, {
    exportedAt: new Date().toISOString(),
    cleared: clear,
    total: misses.length,
    misses: safeMisses
  });

  console.log(`共收集到 ${misses.length} 条疑似漏翻，已保存到 _generated/${path.basename(outFile)}${clear ? "（应用内记录已清空）" : ""}`);
  if (SHOW_DETAILS) {
    for (const item of safeMisses.slice(0, 50)) {
      console.log(`${String(item.count).padStart(4)}  ${item.text}${item.where ? "   [" + item.where + "]" : ""}`);
    }
    if (misses.length > 50) console.log(`... 其余 ${misses.length - 50} 条见 JSON 文件`);
  }
}

main().catch((error) => {
  console.error("收集漏翻失败，请确认 Postman 已启动；可使用 --details 查看详细信息。");
  if (SHOW_DETAILS) console.error(JSON.stringify(sanitizeAuditReport({ ok: false, error: error && error.message || String(error) })));
  process.exit(1);
});
