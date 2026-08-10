#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status} ${url}`);
  return response.json();
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
    if (message.error) cb.reject(new Error(message.error.message));
    else cb.resolve(message.result);
  });
  return {
    send(method, params = {}) {
      const id = nextId++;
      ws.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        setTimeout(() => {
          if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout: ${method}`)); }
        }, 30000);
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
  const portFile = path.join(process.env.APPDATA || "", "Postman", "DevToolsActivePort");
  const port = fs.readFileSync(portFile, "utf8").split(/\r?\n/)[0].trim();
  const targets = await getJson(`http://127.0.0.1:${port}/json/list`);
  const target = targets.find((t) => t.type === "page" && /desktop\.postman\.com|requester\.html/i.test(t.url || ""));
  if (!target) throw new Error("Postman requester target not found");
  const cdp = await connectCdp(target.webSocketDebuggerUrl);
  const outDir = path.resolve(__dirname, "..", "..", "..", "_generated");
  fs.mkdirSync(outDir, { recursive: true });
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

    // Open header settings gear, then the settings entry in its menu
    const headerButtons = await evaluate(cdp, `(() => {
      const norm = (s) => String(s || "").replace(/\\s+/g, " ").trim();
      return Array.from(document.querySelectorAll("button,[role=button],[aria-label]")).map((n) => {
        const r = n.getBoundingClientRect();
        return { label: norm(n.getAttribute("aria-label")) || norm(n.innerText), x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width };
      }).filter((i) => i.w > 2 && i.y < 50 && i.label);
    })()`);
    console.error("header:", JSON.stringify(headerButtons));
    let gear = headerButtons.find((i) => /设置|Settings/i.test(i.label));
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
    if (entry) {
      const pressKey = async (key, code, vk) => {
        await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key, code, windowsVirtualKeyCode: vk });
        await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: vk });
        await sleep(150);
      };
      await pressKey("ArrowDown", "ArrowDown", 40);
      await pressKey("Enter", "Enter", 13);
    }
    await sleep(1500);

    let clickedTab = await clickByText("更新");
    if (!clickedTab) clickedTab = await clickByText("Update");
    await sleep(2500);

    const text = await evaluate(cdp, `(() => {
      const dialogs = Array.from(document.querySelectorAll('[class*="settings"],[class*="modal"],[role="dialog"]'));
      const container = dialogs.find((d) => d.getBoundingClientRect().width > 400) || document.body;
      return container.innerText.slice(0, 4000);
    })()`);

    const screenshot = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true });
    fs.writeFileSync(path.join(outDir, "update-page-probe.png"), Buffer.from(screenshot.data, "base64"));
    fs.writeFileSync(path.join(outDir, "update-page-probe.json"), JSON.stringify({ clickedTab, text }, null, 2), "utf8");
    console.log(JSON.stringify({ clickedTab, textPreview: text.slice(0, 600) }, null, 2));
  } finally {
    cdp.close();
  }
}

main().catch((error) => {
  console.error(error && error.stack || error);
  process.exit(1);
});
