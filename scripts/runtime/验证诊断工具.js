"use strict";

// 离线执行真实模块；套接字、时钟和文件写入均由内存桩承接。
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { connectCdp, isCdpTimeoutError } = require("../lib/CDP客户端.js");
const { sanitizeDiagnosticReport, DIAGNOSTIC_GENERATED_DIR } = require("../lib/诊断输出.js");

function fakeClock() {
  let time = 1000, next = 1;
  const pending = new Map();
  return {
    pending,
    now: () => time,
    setTimeout(fn, delay) { const id = next++; pending.set(id, { fn, due: time + delay }); return id; },
    clearTimeout(id) { pending.delete(id); },
    tick(ms) {
      const end = time + ms;
      while (true) {
        const nextTimer = [...pending.entries()].filter(([, timer]) => timer.due <= end).sort((a, b) => a[1].due - b[1].due)[0];
        if (!nextTimer) break;
        const [id, timer] = nextTimer;
        pending.delete(id); time = timer.due; timer.fn();
      }
      time = end;
    }
  };
}

class FakeWebSocket {
  static OPEN = 1;
  static instances = [];
  constructor() {
    this.readyState = 0; this.listeners = new Map(); this.sent = [];
    FakeWebSocket.instances.push(this);
  }
  addEventListener(type, fn) { const set = this.listeners.get(type) || new Set(); set.add(fn); this.listeners.set(type, set); }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  emit(type, event = {}) { for (const fn of [...(this.listeners.get(type) || [])]) fn(event); }
  open() { this.readyState = 1; this.emit("open"); }
  close() { this.readyState = 3; this.emit("close"); }
  send(raw) {
    if (this.sendError) throw this.sendError;
    const command = JSON.parse(raw); this.sent.push(command);
    if (this.onSend) this.onSend(command);
  }
  reply(command, result = {}, error = null) {
    this.emit("message", { data: JSON.stringify({ id: command.id, ...(command.sessionId ? { sessionId: command.sessionId } : {}), ...(error ? { error } : { result }) }) });
  }
}

async function openFixture(options = {}) {
  const clock = fakeClock();
  const opening = connectCdp("ws://fixture", { WebSocketImpl: FakeWebSocket, timers: clock, ...options });
  const socket = FakeWebSocket.instances.at(-1); socket.open();
  return { clock, socket, cdp: await opening };
}

function outputFixture() {
  const state = {
    files: new Map(), kinds: new Map([[DIAGNOSTIC_GENERATED_DIR, "directory"]]),
    writes: [], renames: [], unlinks: [], directories: [], stats: [], writeError: null, renameError: null, beforeRename: null
  };
  const failure = code => Object.assign(new Error("fixture " + code), { code });
  const io = {
    mkdirSync(file) {
      state.directories.push(file);
      if (!state.kinds.has(file)) state.kinds.set(file, "directory");
      if (state.kinds.get(file) === "file") throw failure("EEXIST");
    },
    lstatSync(file) {
      state.stats.push(file);
      const kind = state.kinds.get(file) || (state.files.has(file) ? "file" : null);
      if (!kind) throw failure("ENOENT");
      return { isDirectory: () => kind === "directory", isFile: () => kind === "file", isSymbolicLink: () => kind === "symlink" };
    },
    writeFileSync(file, data, options) {
      if (options?.flag === "wx" && state.files.has(file)) throw failure("EEXIST");
      const bytes = Buffer.isBuffer(data) ? Buffer.from(data) : Buffer.from(String(data), "utf8");
      state.writes.push({ file, bytes, options });
      state.files.set(file, state.writeError ? bytes.subarray(0, 8) : bytes);
      if (state.writeError) throw failure(state.writeError);
    },
    renameSync(from, to) {
      state.renames.push({ from, to });
      if (state.beforeRename) state.beforeRename(from, to);
      if (state.renameError) throw failure(state.renameError);
      if (!state.files.has(from)) throw failure("ENOENT");
      state.files.set(to, state.files.get(from)); state.files.delete(from);
    },
    unlinkSync(file) {
      state.unlinks.push(file);
      if (!state.files.delete(file)) throw failure("ENOENT");
    }
  };
  const filename = path.join(__dirname, "../lib/诊断输出.js");
  const module = { exports: {} };
  let sequence = 0;
  const modules = { "node:fs": io, "node:path": path, "node:crypto": { randomUUID: () => "fixture-" + ++sequence } };
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), {
    module, exports: module.exports, __dirname: path.dirname(filename), Buffer, URL, process: { pid: 1 },
    require: name => { assert.ok(Object.hasOwn(modules, name), name); return modules[name]; }
  }, { filename, timeout: 1000 });
  return { ...state, state, tools: module.exports };
}

async function runDiagnosticTests() {
  let passed = 0;
  const check = async (name, run) => {
    try { await run(); passed++; }
    catch (error) { error.message = `${name}: ${error.message}`; throw error; }
  };
  await check("CDP success and synchronous reply clear timers", async () => {
    const { cdp, socket, clock } = await openFixture({ commandTimeoutMs: 60000 });
    assert.equal(clock.pending.size, 0);
    const response = cdp.send("Runtime.enable");
    assert.equal(clock.pending.size, 1);
    socket.reply(socket.sent[0], { enabled: true });
    assert.deepEqual(await response, { enabled: true });
    assert.equal(clock.pending.size, 0);
    socket.onSend = command => socket.reply(command, { synchronous: true });
    assert.deepEqual(await cdp.send("Page.enable"), { synchronous: true });
    cdp.close(); cdp.close();
    assert.equal(clock.pending.size, 0);
    assert.equal([...socket.listeners.values()].reduce((n, set) => n + set.size, 0), 0);
  });
  await check("CDP events, sessions and malformed frames", async () => {
    const { cdp, socket, clock } = await openFixture();
    const events = [];
    const off = cdp.on("Debugger.scriptParsed", params => events.push(params.scriptId), { sessionId: "session-a" });
    socket.emit("message", { data: "not-json" });
    socket.emit("message", { data: "null" });
    socket.emit("message", { data: JSON.stringify({ method: "Debugger.scriptParsed", sessionId: "session-b", params: { scriptId: "ignored" } }) });
    socket.emit("message", { data: JSON.stringify({ method: "Debugger.scriptParsed", sessionId: "session-a", params: { scriptId: "expected" } }) });
    off();
    const first = cdp.send("Runtime.enable", {}, { sessionId: "session-a" });
    const second = cdp.send("Runtime.enable", {}, { sessionId: "session-b" });
    socket.reply({ ...socket.sent[0], sessionId: "wrong" });
    assert.equal(clock.pending.size, 2);
    socket.reply(socket.sent[1], { order: 2 }); socket.reply(socket.sent[0], { order: 1 });
    assert.deepEqual(await first, { order: 1 }); assert.deepEqual(await second, { order: 2 });
    assert.deepEqual(events, ["expected"]); assert.equal(clock.pending.size, 0); cdp.close();
  });
  await check("CDP protocol and send exceptions clean pending work", async () => {
    const { cdp, socket, clock } = await openFixture();
    const response = cdp.send("Runtime.enable");
    const rejected = assert.rejects(response, error => error.code === "CDP_PROTOCOL" && error.protocolCode === -1);
    socket.reply(socket.sent[0], null, { code: -1, message: "Fixture error" }); await rejected;
    socket.sendError = new Error("send failure");
    await assert.rejects(cdp.send("Runtime.enable"), /send failure/);
    assert.equal(clock.pending.size, 0); cdp.close();
  });
  for (const event of ["close", "error", "explicit-close"]) await check(`CDP ${event} settles every waiter`, async () => {
    const { cdp, socket, clock } = await openFixture();
    const waiters = [cdp.send("Runtime.enable"), cdp.send("Page.enable")];
    const rejected = waiters.map(promise => assert.rejects(promise, error => /CDP_(?:CLOSED|CONNECTION)/.test(error.code)));
    if (event === "explicit-close") cdp.close(); else socket.emit(event);
    await Promise.all(rejected);
    assert.equal(clock.pending.size, 0); await assert.rejects(cdp.send("Page.enable"), { code: "CDP_CLOSED" });
  });
  await check("CDP command timeout preserves requested policy", async () => {
    const { cdp, socket, clock } = await openFixture({ commandTimeoutMs: 60000 });
    const rejected = assert.rejects(cdp.send("Debugger.getScriptSource"), { code: "CDP_TIMEOUT" });
    clock.tick(59999); assert.equal(clock.pending.size, 1); clock.tick(1); await rejected;
    assert.equal(socket.readyState, 1); assert.equal(clock.pending.size, 0); cdp.close();
  });
  await check("CDP timeout closes and clears concurrent calls when selected", async () => {
    const { cdp, socket, clock } = await openFixture({ closeOnTimeout: true });
    const first = assert.rejects(cdp.send("Runtime.evaluate", {}, { timeoutMs: 10 }), { code: "CDP_TIMEOUT" });
    const second = assert.rejects(cdp.send("Page.enable"), { code: "CDP_TIMEOUT" });
    clock.tick(10); await Promise.all([first, second]); assert.equal(socket.readyState, 3); assert.equal(clock.pending.size, 0);
  });
  await check("CDP handshake timeout and early close clean listeners", async () => {
    for (const earlyClose of [false, true]) {
      const clock = fakeClock();
      const opening = connectCdp("ws://fixture", { WebSocketImpl: FakeWebSocket, timers: clock, connectTimeoutMs: 20 });
      const socket = FakeWebSocket.instances.at(-1);
      const rejected = assert.rejects(opening, error => error.code === (earlyClose ? "CDP_CLOSED" : "CDP_TIMEOUT"));
      if (earlyClose) socket.close(); else clock.tick(20);
      await rejected; assert.equal(clock.pending.size, 0); assert.equal(socket.readyState, 3);
    }
  });
  await check("CDP deadline is enforced during connection and commands", async () => {
    const clock = fakeClock(), count = FakeWebSocket.instances.length;
    await assert.rejects(connectCdp("ws://fixture", { WebSocketImpl: FakeWebSocket, timers: clock, deadline: 999 }), { code: "AUDIT_BUDGET" });
    assert.equal(FakeWebSocket.instances.length, count);
    const opening = connectCdp("ws://fixture", { WebSocketImpl: FakeWebSocket, timers: clock, deadline: 1010 });
    const rejected = assert.rejects(opening, { code: "AUDIT_BUDGET" }); clock.tick(10); await rejected;
    const fixture = await openFixture({ deadline: 1010, closeOnTimeout: true });
    const timedOut = assert.rejects(fixture.cdp.send("Runtime.evaluate"), error => isCdpTimeoutError(error) && error.code === "AUDIT_BUDGET");
    fixture.clock.tick(10); await timedOut; assert.equal(fixture.clock.pending.size, 0);
  });
  await check("CDP rejects new calls after deadline and closes on budget policy", async () => {
    const fixture = await openFixture({ deadline: 1010, closeOnTimeout: true });
    fixture.clock.tick(20);
    await assert.rejects(fixture.cdp.send("Runtime.evaluate"), { code: "AUDIT_BUDGET" });
    assert.equal(fixture.socket.sent.length, 0); assert.equal(fixture.socket.readyState, 3); assert.equal(fixture.clock.pending.size, 0);
  });

  const candidates = Array.from({ length: 600 }, (_, index) => ({ text: "Please configure request setting " + index, kind: "text", count: 1 }));
  await check("diagnostic findings retain final counts and truncation", () => {
    const report = sanitizeDiagnosticReport({ complete: true, summary: { findings: 600 }, findings: candidates });
    assert.equal(report.findings.length, 500); assert.equal(report.summary.findings, 500);
    assert.equal(report.reportTruncation.omittedEntries, 100); assert.equal(report.complete, false);
    assert.deepEqual(sanitizeDiagnosticReport(report), report);
  });
  await check("identity and technical noise are filtered before limits", () => {
    const report = sanitizeDiagnosticReport({
      findings: [{ text: "fixture-user avatar" }, { text: "fixture-user" }, { text: "demo-team team logo" }, { text: "demo-team" },
        { text: "fixture@example.test" }, { text: "WORKSPACE-README.md" }, { text: "GET 未命名请求" },
        ...Array.from({ length: 100 }, () => ({ text: "button", kind: "ax-role" })), ...candidates]
    });
    assert.equal(report.findings.length, 500); assert.equal(report.reportTruncation.omittedEntries, 100);
    assert.equal(report.findings[0].text, candidates[0].text);
  });
  await check("diagnostic finding options validate limits and retain long text", () => {
    const long = "Please explain this configuration carefully. ".repeat(40);
    const report = sanitizeDiagnosticReport({ findings: [...candidates, { text: long }] }, { findingLimit: null, findingTextLimit: 1200 });
    assert.equal(report.findings.length, 601); assert.equal(report.findings[600].text.length, 1200);
    assert.equal(report.reportTruncation, undefined);
    for (const findingLimit of [0, -1, 1.5, "10"]) assert.throws(() => sanitizeDiagnosticReport({}, { findingLimit }), /findingLimit/);
    for (const findingTextLimit of [0, 1201, 2.5, null]) assert.throws(() => sanitizeDiagnosticReport({}, { findingTextLimit }), /findingTextLimit/);
  });
  await check("sensitive fields and body-like text are removed", () => {
    const report = sanitizeDiagnosticReport({
      target: { title: "Postman", url: "https://user:private@example.test/path?token=query-private#private", id: "private-target" },
      source: { port: 1234, portFile: "C:\\Users\\Example\\DevToolsActivePort" },
      request: { status: 200, headers: { Authorization: "Bearer header-private" }, postData: "request-private",
        response: { status: 201, body: "response-private" } },
      inputValue: "input-private", payload: { text: "payload-private" }, token: "token-private",
      sessionId: "session-private", webSocketDebuggerUrl: "ws://127.0.0.1:1234/devtools/browser/ws-private",
      findings: ["Open request", { text: '{"requestBody":"body-private","name":"private"}' }]
    });
    const serialized = JSON.stringify(report);
    assert.equal(report.target.url, "https://example.test/path");
    assert.equal(report.source.port, 1234); assert.equal(report.source.portFile, undefined);
    assert.equal(report.request.status, 200); assert.equal(report.request.response.status, 201);
    assert.equal(report.findings[0].text, "Open request");
    assert.equal(report.findings[1].text, "[疑似请求/响应正文已隐藏]");
    assert.equal(/private|Example|ws:\/\//.test(serialized), false);
  });
  await check("embedded tokens, URLs and local paths are redacted", () => {
    const report = sanitizeDiagnosticReport({
      error: 'Read "C:\\Users\\Example\\local-private.txt"; \\\\server\\share\\unc-private.txt; /home/example/unix-private.txt; Authorization: Bearer auth-private; https://example.test/path?token=url-private; ws://127.0.0.1:1234/devtools/browser/ws-private',
      hints: ["token=token-private", "Bearer bearer-private", "ghp_abcdef123456", "Open /relative/path?token=relative-private"],
      out: "C:\\Users\\Example\\_generated\\diagnostic.json", screenshot: null,
      localUrl: "file:///C:/Users/Example/app/html/requester.html", otherUrl: "file:///home/example/local-private.html"
    });
    const serialized = JSON.stringify(report);
    assert.equal(/private|Example|example\/|ghp_abcdef|ws:\/\//.test(serialized), false);
    assert.equal(report.out, "diagnostic.json"); assert.equal(report.screenshot, null);
    assert.equal(report.localUrl, "file:///…/requester.html"); assert.equal(report.otherUrl, "file:///…");
    assert.ok(report.error.includes("https://example.test/path"));
    assert.equal(report.hints[3], "Open /relative/path");
  });
  await check("raw collections are compacted and keep partial status", () => {
    const report = sanitizeDiagnosticReport({ complete: true,
      targets: [{ complete: false, title: "private-target" }],
      snapshots: [{ text: "private-snapshot" }], actions: [{ name: "private-action" }], entries: [{ text: "private-entry" }]
    });
    for (const name of ["targets", "snapshots", "actions", "entries"]) assert.deepEqual(report[name], { count: 1 });
    assert.equal(report.complete, false); assert.equal(JSON.stringify(report).includes("private"), false);
    const hits = sanitizeDiagnosticReport({ hitCount: 2, summary: { hitCount: 2 }, hits: ["button", "Open request"] });
    assert.equal(hits.hitCount, 1); assert.equal(hits.summary.hitCount, 1);
  });
  await check("output helper loads without filesystem side effects", () => {
    const fixture = outputFixture();
    assert.deepEqual(Object.keys(fixture.tools).sort(), ["DIAGNOSTIC_GENERATED_DIR", "resolveDiagnosticOutputPath", "sanitizeDiagnosticReport", "writeDiagnosticReport", "writeDiagnosticScreenshot"].sort());
    assert.equal(fixture.files.size, 0); assert.equal(fixture.writes.length, 0);
    assert.equal(fixture.renames.length, 0); assert.equal(fixture.unlinks.length, 0);
    assert.equal(fixture.directories.length, 0); assert.equal(fixture.stats.length, 0);
  });
  await check("diagnostic report names stay in the sibling generated directory", () => {
    const { tools } = outputFixture();
    assert.equal(tools.DIAGNOSTIC_GENERATED_DIR, DIAGNOSTIC_GENERATED_DIR);
    assert.equal(tools.resolveDiagnosticOutputPath("自检报告"), path.join(DIAGNOSTIC_GENERATED_DIR, "自检报告.json"));
    assert.equal(tools.resolveDiagnosticOutputPath("自检报告.png"), path.join(DIAGNOSTIC_GENERATED_DIR, "自检报告.json"));
    assert.equal(tools.resolveDiagnosticOutputPath(), path.join(DIAGNOSTIC_GENERATED_DIR, "diagnostic-report.json"));
    for (const value of ["../outside.json", "..\\outside.json", "C:\\outside.json", "/tmp/outside.json", "sub/report.json", "report.txt", "report:stream.json", "--details", " ", "bad\0name.json"]) {
      assert.throws(() => tools.resolveDiagnosticOutputPath(value));
    }
  });
  await check("JSON and PNG writers reject outside paths and wrong extensions", () => {
    const fixture = outputFixture();
    for (const [write, extension, data] of [[fixture.tools.writeDiagnosticReport, ".json", {}], [fixture.tools.writeDiagnosticScreenshot, ".png", "iVBORw=="]]) {
      for (const file of [path.join(DIAGNOSTIC_GENERATED_DIR, "..", "outside" + extension), path.join(DIAGNOSTIC_GENERATED_DIR, "nested", "report" + extension), path.join(DIAGNOSTIC_GENERATED_DIR, "report.txt"), path.join(DIAGNOSTIC_GENERATED_DIR, "report" + extension + ":stream")]) {
        assert.throws(() => write(file, data));
      }
    }
    assert.equal(fixture.writes.length, 0);
  });
  await check("output directory and existing files reject links or non-files", () => {
    for (const kind of ["symlink", "file"]) {
      const fixture = outputFixture(); fixture.kinds.set(DIAGNOSTIC_GENERATED_DIR, kind);
      assert.throws(() => fixture.tools.resolveDiagnosticOutputPath("report"));
      assert.equal(fixture.writes.length, 0);
    }
    for (const kind of ["symlink", "directory"]) {
      for (const extension of [".json", ".png"]) {
        const fixture = outputFixture(), file = path.join(DIAGNOSTIC_GENERATED_DIR, "report" + extension);
        fixture.kinds.set(file, kind);
        assert.throws(() => extension === ".json" ? fixture.tools.writeDiagnosticReport(file, {}) : fixture.tools.writeDiagnosticScreenshot(file, "iVBORw=="));
        assert.equal(fixture.writes.length, 0);
      }
    }
  });
  await check("atomic report writes only sanitized content before replacement", () => {
    const fixture = outputFixture(), file = fixture.tools.resolveDiagnosticOutputPath("atomic");
    fixture.files.set(file, Buffer.from("previous report"));
    fixture.state.beforeRename = (temporary, destination) => {
      assert.equal(destination, file); assert.equal(fixture.files.get(file).toString(), "previous report");
      assert.equal(path.dirname(temporary), DIAGNOSTIC_GENERATED_DIR);
      assert.equal(JSON.parse(fixture.files.get(temporary)).token, undefined);
    };
    const result = fixture.tools.writeDiagnosticReport(file, { token: "private-token", findings: [{ text: "Open https://example.test/?token=private-query" }] });
    assert.equal(fixture.writes.length, 1); assert.equal(fixture.writes[0].options.flag, "wx");
    assert.equal(fixture.renames.length, 1); assert.equal(fixture.files.size, 1);
    assert.deepEqual(JSON.parse(fixture.files.get(file)), JSON.parse(JSON.stringify(result)));
    assert.equal(fixture.writes[0].bytes.toString().includes("private"), false);
  });
  for (const failingOperation of ["writeError", "renameError"]) await check(`atomic ${failingOperation} preserves the previous report and removes its temporary file`, () => {
    const fixture = outputFixture(), file = fixture.tools.resolveDiagnosticOutputPath("failure");
    fixture.files.set(file, Buffer.from("previous report")); fixture.state[failingOperation] = "EIO";
    assert.throws(() => fixture.tools.writeDiagnosticReport(file, { ok: true }), /EIO/);
    assert.equal(fixture.files.get(file).toString(), "previous report"); assert.equal(fixture.files.size, 1);
    assert.equal(fixture.unlinks.length, 1);
  });
  await check("invalid report options fail before writing", () => {
    const fixture = outputFixture(), file = fixture.tools.resolveDiagnosticOutputPath("invalid");
    assert.throws(() => fixture.tools.writeDiagnosticReport(file, {}, { findingLimit: 0 }), /findingLimit/);
    assert.equal(fixture.writes.length, 0); assert.equal(fixture.renames.length, 0);
  });
  await check("screenshots preserve supplied pixels and validate base64", () => {
    const fixture = outputFixture(), file = path.join(DIAGNOSTIC_GENERATED_DIR, "image.png");
    const pixels = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    fixture.tools.writeDiagnosticScreenshot(file, pixels);
    assert.deepEqual(fixture.files.get(file), pixels);
    fixture.tools.writeDiagnosticScreenshot(file, pixels.toString("base64"));
    assert.deepEqual(fixture.files.get(file), pixels);
    const writes = fixture.writes.length;
    for (const data of [{ data: "iVBORw==" }, "不是 base64", "a", "====", "AB=="]) assert.throws(() => fixture.tools.writeDiagnosticScreenshot(file, data));
    assert.equal(fixture.writes.length, writes);
  });
  return { passed, offline: true };
}

module.exports = { runDiagnosticTests };
