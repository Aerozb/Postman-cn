#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

// --out names the JSON report. Bare names use the sibling _generated folder;
// paths with a directory use the caller's working directory. The screenshot
// uses the same directory and basename with a .png extension.
function outputPaths() {
  const index = process.argv.indexOf("--out");
  const generatedDir = path.resolve(__dirname, "..", "..", "..", "_generated");
  let reportPath = path.join(generatedDir, "update-page-probe.json");
  if (index >= 0) {
    const value = process.argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error("--out requires a JSON report path");
    }
    const hasDirectory = path.isAbsolute(value) || value.includes("/") || value.includes("\\");
    reportPath = hasDirectory ? path.resolve(value) : path.join(generatedDir, value);
    const extension = path.extname(reportPath);
    if (!extension) {
      reportPath += ".json";
    } else if (extension.toLowerCase() !== ".json") {
      throw new Error("--out must use a .json extension or no extension");
    }
  }
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
    if (!response.ok) throw new Error(`HTTP ${response.status} ${url}`);
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
    const timer = setTimeout(() => reject(new Error("CDP connect timeout")), 10000);
    ws.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("CDP connect failed")); }, { once: true });
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
      cb.reject(new Error(`CDP closed while waiting for request ${id}`));
    }
    pending.clear();
  });
  return {
    send(method, params = {}, timeoutMs = 30000) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout: ${method}`)); }
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    close() { try { ws.close(); } catch (_) {} }
  };
}

async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}

async function main() {
  const { reportPath, screenshotPath } = outputPaths();
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  const portFile = path.join(process.env.APPDATA || "", "Postman", "DevToolsActivePort");
  const port = fs.readFileSync(portFile, "utf8").split(/\r?\n/)[0].trim();
  const targets = await getJson(`http://127.0.0.1:${port}/json/list`);
  const target = targets.find((t) => t.type === "page" && /(?:^https:\/\/desktop\.postman\.com(?::\d+)?(?:[\/?#]|$)|^file:\/\/\/.*\/(?:requester|scratchpad)\.html(?:[?#]|$))/i.test(t.url || ""));
  if (!target) throw new Error("Postman requester target not found");
  const cdp = await connectCdp(target.webSocketDebuggerUrl);
  try {
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");

    const clickByText = (label) => evaluate(cdp, `(() => {
      const norm = (s) => String(s || "").replace(/\\s+/g, " ").trim();
      const nodes = Array.from(document.querySelectorAll("button,a,[role],[tabindex],span,div"));
      const el = nodes.find((n) => norm(n.innerText) === ${JSON.stringify(label)} && n.getBoundingClientRect().width > 0);
      if (!el) return false;
      el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      el.click();
      return true;
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

    // Reuse an already-open settings dialog so the probe is safe to rerun.
    let clickedTab = await clickByText("更新");
    if (!clickedTab) clickedTab = await clickByText("Update");

    if (!clickedTab) {
      // Open header settings gear, then the settings entry in its menu.
      const headerButtons = await evaluate(cdp, `(() => {
      const norm = (s) => String(s || "").replace(/\\s+/g, " ").trim();
      return Array.from(document.querySelectorAll("button,[role=button],[aria-label],[title],[data-testid],[tabindex]")).map((n) => {
        const r = n.getBoundingClientRect();
        const svgTitle = n.querySelector && n.querySelector("svg title");
        const label = norm(n.getAttribute("aria-label")) || norm(n.getAttribute("title")) || norm(n.innerText) || norm(svgTitle && svgTitle.textContent);
        const meta = [label, n.getAttribute("data-testid"), n.className, n.outerHTML && n.outerHTML.slice(0, 300)].map(norm).join(" ");
        return { label, meta, x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height };
      }).filter((i) => i.w > 2 && i.h > 2 && i.y < 60);
    })()`);
      console.error("header:", JSON.stringify(headerButtons));
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
      if (!gear) throw new Error("settings gear not found");
      await realClick(gear);
      await sleep(1200);
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
      console.error("overlay:", JSON.stringify(overlayItems));
      const entryItem = overlayItems.find((i) => /^(应用设置|设置|Settings)$/.test(i.t));
      const entry = entryItem ? { x: entryItem.x, y: entryItem.y } : null;
      if (!entry) throw new Error("settings menu entry not found");
      await realClick(entry);
      await sleep(1500);

      clickedTab = await clickByText("更新");
      if (!clickedTab) clickedTab = await clickByText("Update");
      if (!clickedTab) throw new Error("update settings tab not found");
    }
    await sleep(2500);

    const text = await evaluate(cdp, `(() => {
      const dialogs = Array.from(document.querySelectorAll('[class*="settings"],[class*="modal"],[role="dialog"]'));
      const container = dialogs.find((d) => d.getBoundingClientRect().width > 400) || document.body;
      return container.innerText.slice(0, 4000);
    })()`);
    if (/出现了一些问题|Something went wrong/i.test(text)) {
      throw new Error("update page reported an error state");
    }
    if (!/(?:已是|已经是|已为|当前(?:已)?是|使用的是)最新版本/.test(text)) {
      throw new Error("update page did not report a Chinese up-to-date state");
    }

    const report = { verified: true, language: "zh-CN", clickedTab, text, screenshot: null, screenshotError: null };
    try {
      const screenshot = await cdp.send(
        "Page.captureScreenshot",
        { format: "png", fromSurface: true, captureBeyondViewport: false },
        10000
      );
      fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, "base64"));
      report.screenshot = screenshotPath;
    } catch (error) {
      report.screenshotError = error && error.message || String(error);
      console.error(`[probe] screenshot skipped: ${report.screenshotError}`);
    }
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");
    console.log(JSON.stringify({ verified: true, language: report.language, report: reportPath, clickedTab, screenshot: report.screenshot, screenshotError: report.screenshotError, textPreview: text.slice(0, 600) }, null, 2));
  } finally {
    cdp.close();
  }
}

main().catch((error) => {
  console.error(error && error.stack || error);
  process.exit(1);
});
