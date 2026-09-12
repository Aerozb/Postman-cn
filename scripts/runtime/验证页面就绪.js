"use strict";

const assert = require("node:assert/strict");
const vm = require("node:vm");
const { waitForVerificationReady, VERIFICATION_READY_EXPRESSION } = require("../验证汉化.js");

const READY = { documentReady: true, localizerReady: true, contextMenuReady: true };

function fixture(read) {
  let time = 0;
  const calls = [];
  const delays = [];
  return {
    cdp: {
      async send(method, params, options) {
        assert.equal(method, "Runtime.evaluate");
        assert.equal(params.expression, VERIFICATION_READY_EXPRESSION);
        assert.equal(params.returnByValue, true);
        calls.push(options.timeoutMs);
        return read(time, calls.length);
      }
    },
    clock: { now: () => time, delay: async ms => { delays.push(ms); time += ms; } },
    calls, delays,
    get time() { return time; }
  };
}

async function runPageReadinessTests() {
  let passed = 0;
  const test = async run => { await run(); passed++; };
  const result = state => ({ result: { value: state } });

  await test(async () => {
    const f = fixture(() => result(READY));
    assert.deepEqual(await waitForVerificationReady(f.cdp, 30000, f.clock), READY);
    assert.deepEqual(f.calls, [5000]);
    assert.deepEqual(f.delays, []);
  });
  for (const field of Object.keys(READY)) {
    await test(async () => {
      const f = fixture(time => result({ ...READY, [field]: time >= 2400 }));
      assert.deepEqual(await waitForVerificationReady(f.cdp, 30000, f.clock), READY);
      assert.equal(f.time, 2400, field + " 应按真实状态等待，而非固定 1.5 秒");
    });
  }
  for (const field of Object.keys(READY)) {
    await test(async () => {
      const f = fixture(() => result({ ...READY, [field]: false }));
      await assert.rejects(waitForVerificationReady(f.cdp, 450, f.clock), error => {
        assert.equal(error.code, "POSTMAN_READY_TIMEOUT");
        assert.equal(error.readiness[field], false);
        return true;
      });
      assert.equal(f.time, 450);
      assert.deepEqual(f.calls, [450, 250, 50]);
      assert.deepEqual(f.delays, [200, 200, 50]);
    });
  }
  for (const code of ["CDP_PROTOCOL", "CDP_TIMEOUT"]) {
    await test(async () => {
      const f = fixture((_time, call) => {
        if (call === 1) throw Object.assign(new Error("Execution context was destroyed"), { code });
        return result(READY);
      });
      assert.deepEqual(await waitForVerificationReady(f.cdp, 1000, f.clock), READY);
      assert.equal(f.calls.length, 2);
    });
  }
  await test(async () => {
    const f = fixture((_time, call) => call === 1 ? { exceptionDetails: { text: "导航中" } } : result(READY));
    assert.deepEqual(await waitForVerificationReady(f.cdp, 1000, f.clock), READY);
    assert.equal(f.calls.length, 2);
  });
  await test(async () => {
    const f = fixture(() => { throw Object.assign(new Error("连接关闭"), { code: "CDP_CLOSED" }); });
    await assert.rejects(waitForVerificationReady(f.cdp, 1000, f.clock), { code: "CDP_CLOSED" });
    assert.equal(f.calls.length, 1);
    assert.equal(f.time, 0);
  });
  await test(async () => {
    const f = fixture(() => { throw Object.assign(new Error("Method not found"), { code: "CDP_PROTOCOL" }); });
    await assert.rejects(waitForVerificationReady(f.cdp, 1000, f.clock), { code: "CDP_PROTOCOL", message: "Method not found" });
    assert.equal(f.calls.length, 1);
    assert.equal(f.time, 0);
  });
  await test(async () => {
    const f = fixture(() => { throw Object.assign(new Error("读取超时"), { code: "CDP_TIMEOUT" }); });
    await assert.rejects(waitForVerificationReady(f.cdp, 100, f.clock), error => {
      assert.equal(error.code, "POSTMAN_READY_TIMEOUT");
      assert.deepEqual(error.lastReadError, { code: "CDP_TIMEOUT", message: "读取超时" });
      return true;
    });
  });
  await test(async () => {
    let time = 0;
    const cdp = { send: async () => { time = 101; return result(READY); } };
    await assert.rejects(waitForVerificationReady(cdp, 100, { now: () => time }), { code: "POSTMAN_READY_TIMEOUT" });
  });
  await test(async () => {
    const times = [0, 99, 100];
    let sentTimeout = null;
    const cdp = { send: async (_method, _params, options) => { sentTimeout = options.timeoutMs; return result(READY); } };
    await assert.rejects(waitForVerificationReady(cdp, 100, { now: () => times.shift() ?? 100 }), { code: "POSTMAN_READY_TIMEOUT" });
    assert.equal(sentTimeout, 1, "发送前只读取一次时钟，保持正数超时");
  });
  await test(async () => {
    const times = [0, 100];
    const cdp = { send: async () => { throw new Error("预算耗尽后仍发送了命令"); } };
    await assert.rejects(waitForVerificationReady(cdp, 100, { now: () => times.shift() ?? 100 }), { code: "POSTMAN_READY_TIMEOUT" });
  });
  await test(async () => {
    const f = fixture(() => ({}));
    await assert.rejects(waitForVerificationReady(f.cdp, 100, f.clock), { code: "POSTMAN_READY_TIMEOUT" });
  });
  await test(async () => {
    for (const timeout of [0, -1, NaN, Infinity, "1000"]) {
      await assert.rejects(waitForVerificationReady({}, timeout), RangeError);
    }
  });
  await test(async () => {
    const mutation = () => { throw new Error("就绪检查只读，不应调用翻译或菜单方法"); };
    const context = {
      window: { __POSTMAN_ZH_LOCALIZER__: { translate: mutation, walk: mutation }, pm: { contextMenuManager: { buildMenu: mutation, __postmanZhBuildMenuPatched: true } } },
      document: { readyState: "complete", body: {}, documentElement: { getAttribute: () => "true" } }
    };
    assert.deepEqual(JSON.parse(JSON.stringify(vm.runInNewContext(VERIFICATION_READY_EXPRESSION, context))), READY);
    delete context.window.pm;
    assert.equal(vm.runInNewContext(VERIFICATION_READY_EXPRESSION, context).contextMenuReady, false);
    context.document.readyState = "loading";
    context.document.documentElement.getAttribute = () => null;
    const pending = vm.runInNewContext(VERIFICATION_READY_EXPRESSION, context);
    assert.equal(pending.documentReady, false);
    assert.equal(pending.localizerReady, false);
  });
  await test(async () => {
    const context = {
      window: { __POSTMAN_ZH_LOCALIZER__: { translate() {}, walk() {} }, pm: { contextMenuManager: { buildMenu() {} } } },
      document: { readyState: "complete", body: {}, documentElement: { getAttribute: () => "true" } }
    };
    const f = fixture(time => {
      if (time >= 400) context.window.pm.contextMenuManager.__postmanZhBuildMenuPatched = true;
      return result(JSON.parse(JSON.stringify(vm.runInNewContext(VERIFICATION_READY_EXPRESSION, context))));
    });
    assert.deepEqual(await waitForVerificationReady(f.cdp, 1000, f.clock), READY);
    assert.equal(f.time, 400, "原始菜单方法出现后，仍需等汉化包装器完成");
  });
  return { passed };
}

module.exports = { runPageReadinessTests };
