#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const SHOW_DETAILS = process.argv.includes("--details");
const SAVE_SCREENSHOT = process.argv.includes("--screenshot");
const {
  sanitizeAuditReport,
  resolveAuditOutputPath,
  writeAuditReport,
  writeAuditScreenshot
} = require("../audit/审计安全.js");

// --out accepts only a filename. Reports and optional screenshots are kept in
// the workspace-sibling _generated directory.
function outputPaths() {
  const index = process.argv.indexOf("--out");
  const requested = index >= 0 ? process.argv[index + 1] : null;
  const reportPath = resolveAuditOutputPath(requested, "update-page-probe.json");
  const parsed = path.parse(reportPath);
  return {
    reportPath,
    screenshotPath: path.join(parsed.dir, `${parsed.name}.png`)
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP 请求失败：状态码 ${response.status}，地址 ${url}`);
    return response.json();
  } finally {
    clearTimeout(timer);
  }
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
  ws.addEventListener("close", () => {
    for (const [id, cb] of pending) {
      clearTimeout(cb.timer);
      cb.reject(new Error(`等待请求 ${id} 时 CDP 连接已关闭。`));
    }
    pending.clear();
  });
  return {
    send(method, params = {}, timeoutMs = 30000) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (pending.has(id)) { pending.delete(id); reject(new Error(`CDP 方法执行超时：${method}`)); }
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        try {
          ws.send(JSON.stringify({ id, method, params }));
        } catch (error) {
          clearTimeout(timer);
          pending.delete(id);
          reject(error);
        }
      });
    },
    close() { try { ws.close(); } catch (_) {} }
  };
}

async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) {
    const message = result.exceptionDetails.text || "页面脚本执行失败。";
    const details = SHOW_DETAILS
      ? ` 诊断：${JSON.stringify(sanitizeAuditReport(result.exceptionDetails))}`
      : "";
    throw new Error(`${message}${details}`);
  }
  return result.result.value;
}

async function main() {
  const { reportPath, screenshotPath } = outputPaths();
  const portFile = path.join(process.env.APPDATA || "", "Postman", "DevToolsActivePort");
  if (!fs.existsSync(portFile)) {
    throw new Error("找不到 DevToolsActivePort。请先通过 postman-zh.bat start 启动 Postman。");
  }
  const port = fs.readFileSync(portFile, "utf8").split(/\r?\n/)[0].trim();
  const targets = await getJson(`http://127.0.0.1:${port}/json/list`);
  const target = targets.find((t) => t.type === "page" && /(?:^https:\/\/desktop\.postman\.com(?::\d+)?(?:[\/?#]|$)|^file:\/\/\/.*\/(?:requester|scratchpad)\.html(?:[?#]|$))/i.test(t.url || ""));
  if (!target) throw new Error("没有找到 Postman 请求编辑器页面。");
  const cdp = await connectCdp(target.webSocketDebuggerUrl);
  try {
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");

    const findSettingsTab = () => evaluate(cdp, `(() => {
      const norm = (s) => String(s || "").replace(/\\s+/g, " ").trim();
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return r.width > 2 && r.height > 2 && r.bottom > 0 && r.right > 0 &&
          r.top < innerHeight && r.left < innerWidth && style.visibility !== "hidden" && style.display !== "none";
      };
      const roots = Array.from(document.querySelectorAll('[role="dialog"],[aria-modal="true"],[class*="settings" i]'))
        .filter((root) => visible(root) && /(?:通用|General)/i.test(norm(root.innerText)) && /(?:关于|About)/i.test(norm(root.innerText)));
      for (const root of roots) {
        const el = Array.from(root.querySelectorAll("button,[role=tab],[role=button],[tabindex],span,div"))
          .find((node) => /^(?:更新|Update)$/.test(norm(node.innerText)) && visible(node));
        if (!el) continue;
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }
      return null;
    })()`);

    const findPoint = (label) => evaluate(cdp, `(() => {
      const norm = (s) => String(s || "").replace(/\\s+/g, " ").trim();
      const nodes = Array.from(document.querySelectorAll("button,a,[role],[tabindex],[aria-label],span,div"));
      const el = nodes.find((n) => {
        const t = norm(n.getAttribute && n.getAttribute("aria-label")) || norm(n.innerText);
        if (t !== ${JSON.stringify(label)}) return false;
        const r = n.getBoundingClientRect();
        return r.width > 2 && r.height > 2 && r.y < 50;
      });
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);

    const realClick = async (pt) => {
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: pt.x, y: pt.y });
      await sleep(80);
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: pt.x, y: pt.y, button: "left", clickCount: 1 });
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: pt.x, y: pt.y, button: "left", clickCount: 1 });
    };

    const pressKey = async (key, code, windowsVirtualKeyCode) => {
      await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode });
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode });
    };

    // Reuse an already-open settings dialog so the probe is safe to rerun.
    let updateTab = await findSettingsTab();
    let clickedTab = false;
    if (updateTab) {
      await realClick(updateTab);
      clickedTab = true;
    }

    if (!clickedTab) {
      // Open header settings gear, then the settings entry in its menu.
      const headerButtons = await evaluate(cdp, `(() => {
      const norm = (s) => String(s || "").replace(/\\s+/g, " ").trim();
      return Array.from(document.querySelectorAll("button,[role=button],[aria-label],[title],[data-testid],[tabindex]")).map((n) => {
        const r = n.getBoundingClientRect();
        const svgTitle = n.querySelector && n.querySelector("svg title");
        const label = norm(n.getAttribute("aria-label")) || norm(n.getAttribute("title")) || norm(n.innerText) || norm(svgTitle && svgTitle.textContent);
        const meta = [label, n.getAttribute("data-testid"), n.className, n.tagName].map(norm).join(" ");
        return { label, meta, x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height };
      }).filter((i) => i.w > 2 && i.h > 2 && i.y < 60);
    })()`);
      if (SHOW_DETAILS) console.error(`顶部区域发现 ${headerButtons.length} 个可交互候选。`);
      let gear = headerButtons.find((i) => /设置|settings|gear|cog/i.test(i.meta));
      if (!gear) {
        gear = await evaluate(cdp, `(() => {
        const x = Math.max(20, window.innerWidth - 296), y = 24;
        const raw = document.elementFromPoint(x, y);
        const node = raw && (raw.closest("button,[role=button],[tabindex]") || raw);
        if (!node) return null;
        const r = node.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) return null;
        return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height };
      })()`);
      }
      if (!gear) throw new Error("没有找到设置按钮。");
      await realClick(gear);
      await sleep(600);
      await pressKey("ArrowDown", "ArrowDown", 40);
      await sleep(120);
      await pressKey("Enter", "Enter", 13);
      await sleep(1500);

      updateTab = await findSettingsTab();
      if (!updateTab) {
      const overlayItems = await evaluate(cdp, `(() => {
      const norm = (s) => String(s || "").replace(/\\s+/g, " ").trim();
      const roots = Array.from(document.querySelectorAll('[class*="popover"],[class*="overlay"],[class*="menu"],[class*="Menu"],[class*="dropdown"],[role="menu"],[role="listbox"],[data-popper-placement]'));
      const out = [];
      roots.forEach((root) => {
        Array.from(root.querySelectorAll("*")).forEach((n) => {
          const r = n.getBoundingClientRect();
          if (r.width < 4 || r.height < 4) return;
          const own = Array.from(n.childNodes).filter((c) => c.nodeType === 3).map((c) => norm(c.nodeValue)).join(" ").trim();
          const t = own || norm(n.getAttribute && n.getAttribute("aria-label"));
          if (t) out.push({ t, x: r.x + r.width / 2, y: r.y + r.height / 2 });
        });
      });
      return out.slice(0, 60);
    })()`);
      if (SHOW_DETAILS) console.error(`设置菜单中发现 ${overlayItems.length} 个候选项，尝试坐标点击兜底。`);
      const entryItem = overlayItems.find((i) => /^(应用设置|设置|Settings)$/.test(i.t));
      const entry = entryItem ? { x: entryItem.x, y: entryItem.y } : null;
      if (!entry) throw new Error("没有找到设置菜单项。");
      await realClick(entry);
      await sleep(1500);
        updateTab = await findSettingsTab();
      }

      if (!updateTab) throw new Error("没有找到更新设置标签页。");
      await realClick(updateTab);
      clickedTab = true;
    }
    await sleep(2500);

    const text = await evaluate(cdp, `(() => {
      const dialogs = Array.from(document.querySelectorAll('[class*="settings"],[class*="modal"],[role="dialog"]'));
      const container = dialogs.find((d) => d.getBoundingClientRect().width > 400) || document.body;
      return container.innerText.slice(0, 4000);
    })()`);
    if (/出现了一些问题|Something went wrong/i.test(text)) {
      throw new Error("更新页面显示了错误状态。");
    }
    if (!/(?:已是|已经是|已为|当前(?:已)?是|使用的是)最新版本/.test(text)) {
      throw new Error("更新页面没有显示中文的“已是最新版本”状态。");
    }

    const report = { verified: true, language: "zh-CN", clickedTab, textLength: text.length, screenshot: null, screenshotError: null };
    if (SAVE_SCREENSHOT) {
    try {
      const screenshot = await cdp.send(
        "Page.captureScreenshot",
        { format: "png" },
        30000
      );
      writeAuditScreenshot(screenshotPath, screenshot.data);
      report.screenshot = screenshotPath;
    } catch (error) {
      report.screenshotError = sanitizeAuditReport({ error: error && error.message || String(error) }).error;
      if (SHOW_DETAILS) console.error(`截图失败，已跳过：${report.screenshotError}`);
    }
    }
    writeAuditReport(reportPath, report);
    const screenshotNote = report.screenshotError ? "，截图失败但已跳过" : "";
    console.log(`更新页面验证通过${screenshotNote}，报告已保存到 _generated/${path.basename(reportPath)}。`);
    if (SHOW_DETAILS) {
      console.log(JSON.stringify(sanitizeAuditReport(report), null, 2));
    }
  } finally {
    cdp.close();
  }
}

main().catch((error) => {
  const message = String(error && error.message || error).replace(/\s+/g, " ").trim();
  if (SHOW_DETAILS) {
    console.error(JSON.stringify(sanitizeAuditReport({ error: message, stack: error && error.stack || null }), null, 2));
  } else {
    console.error("探测更新页面失败，请确认 Postman 已启动；可使用 --details 查看脱敏诊断。");
  }
  process.exit(1);
});
