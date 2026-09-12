"use strict";

// Transport only: callers keep their own target discovery and page selection.
// Tests inject a WebSocket and clock; the production path uses Node 22 globals.
function cdpError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isCdpTimeoutError(error) {
  return Boolean(error && (error.code === "AUDIT_BUDGET" || error.code === "CDP_TIMEOUT"));
}

function positiveTimeout(value, name) {
  if (!Number.isFinite(value) || value <= 0) throw new TypeError(`${name} 必须是正数。`);
  return value;
}

async function connectCdp(wsUrl, options = {}) {
  const {
    connectTimeoutMs = 10000,
    commandTimeoutMs = 15000,
    deadline = null,
    closeOnTimeout = false,
    WebSocketImpl = globalThis.WebSocket,
    timers = {}
  } = options;
  positiveTimeout(connectTimeoutMs, "connectTimeoutMs");
  positiveTimeout(commandTimeoutMs, "commandTimeoutMs");
  if (deadline !== null && !Number.isFinite(deadline)) throw new TypeError("deadline 必须是时间戳或 null。");
  const schedule = timers.setTimeout ? timers.setTimeout.bind(timers) : setTimeout;
  const cancel = timers.clearTimeout ? timers.clearTimeout.bind(timers) : clearTimeout;
  const now = timers.now ? timers.now.bind(timers) : Date.now;
  const budgetError = (method) => cdpError(`审计时间预算已耗尽：${method}`, "AUDIT_BUDGET");
  const duration = (timeout, method) => {
    positiveTimeout(timeout, "timeoutMs");
    const remaining = deadline === null ? timeout : deadline - now();
    if (remaining <= 0) throw budgetError(method);
    return Math.min(timeout, remaining);
  };
  const timeoutError = (method, connecting = false) => deadline !== null && now() >= deadline
    ? budgetError(method)
    : cdpError(connecting ? "连接 CDP WebSocket 超时。" : `CDP 命令执行超时：${method}`, "CDP_TIMEOUT");
  const connectDuration = duration(connectTimeoutMs, "连接 CDP");
  const ws = new WebSocketImpl(wsUrl);
  const pending = new Map();
  const handlers = new Map();
  const listeners = [];
  let nextId = 1;
  let closed = false;
  let connectTimer = null;
  let resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const listen = (type, callback) => {
    ws.addEventListener(type, callback);
    listeners.push([type, callback]);
  };
  const finishReady = (error) => {
    if (!resolveReady) return;
    if (connectTimer !== null) cancel(connectTimer);
    connectTimer = null;
    const resolve = resolveReady, reject = rejectReady;
    resolveReady = rejectReady = null;
    if (error) reject(error); else resolve();
  };
  const close = (error = cdpError("CDP 连接已关闭。", "CDP_CLOSED")) => {
    if (closed) return;
    closed = true;
    finishReady(error);
    for (const item of pending.values()) {
      cancel(item.timer);
      item.reject(error);
    }
    pending.clear();
    handlers.clear();
    for (const [type, callback] of listeners) ws.removeEventListener(type, callback);
    listeners.length = 0;
    try { ws.close(); } catch (_) {}
  };
  listen("open", () => finishReady());
  listen("close", () => close(cdpError("CDP WebSocket 已关闭。", "CDP_CLOSED")));
  listen("error", () => close(cdpError("CDP WebSocket 连接出错。", "CDP_CONNECTION")));
  listen("message", (event) => {
    let message;
    try { message = JSON.parse(typeof event.data === "string" ? event.data : event.data.toString()); }
    catch (_) { return; }
    if (!message || typeof message !== "object") return;
    if (message.id !== undefined && pending.has(message.id)) {
      const item = pending.get(message.id);
      // A response belongs to the same flattened session as its command.
      if ((message.sessionId || null) !== item.sessionId) return;
      pending.delete(message.id);
      cancel(item.timer);
      if (message.error) {
        const error = cdpError(message.error.message || "CDP 返回未知错误。", "CDP_PROTOCOL");
        error.protocolCode = message.error.code;
        error.data = message.error.data;
        item.reject(error);
      } else item.resolve(message.result || {});
      return;
    }
    if (message.method && handlers.has(message.method)) {
      for (const handler of [...handlers.get(message.method)]) {
        if (handler.sessionId !== undefined && handler.sessionId !== (message.sessionId || null)) continue;
        handler.callback(message.params, message);
      }
    }
  });
  connectTimer = schedule(() => close(timeoutError("连接 CDP", true)), connectDuration);
  await ready;
  return {
    send(method, params = {}, { timeoutMs = commandTimeoutMs, sessionId = null } = {}) {
      return new Promise((resolve, reject) => {
        if (closed || ws.readyState !== (WebSocketImpl.OPEN ?? 1)) {
          reject(cdpError("CDP WebSocket 未连接。", "CDP_CLOSED"));
          return;
        }
        let commandDuration;
        try { commandDuration = duration(timeoutMs, method); }
        catch (error) { reject(error); if (closeOnTimeout && isCdpTimeoutError(error)) close(error); return; }
        const id = nextId++;
        const timer = schedule(() => {
          if (!pending.has(id)) return;
          pending.delete(id);
          const error = timeoutError(method);
          reject(error);
          if (closeOnTimeout) close(error);
        }, commandDuration);
        pending.set(id, { resolve, reject, timer, sessionId });
        try { ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }
        catch (error) { pending.delete(id); cancel(timer); reject(error); }
      });
    },
    on(method, callback, { sessionId } = {}) {
      if (typeof callback !== "function") throw new TypeError("CDP 事件处理器必须是函数。");
      if (closed) throw cdpError("CDP 连接已关闭。", "CDP_CLOSED");
      const subscriptions = handlers.get(method) || new Set();
      const handler = { callback, sessionId };
      subscriptions.add(handler);
      handlers.set(method, subscriptions);
      return () => {
        subscriptions.delete(handler);
        if (!subscriptions.size) handlers.delete(method);
      };
    },
    close
  };
}

module.exports = { connectCdp, isCdpTimeoutError };
