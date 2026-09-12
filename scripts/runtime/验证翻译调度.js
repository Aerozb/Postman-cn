"use strict";

// 运行真实 payload；仅将最后的自动启动换成测试钩子。DOM、Observer 和时钟均在内存中，
// 不加载 Electron、不读用户数据、不注册真实计时器。公开 localizer 仅 run、translate、walk。
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function fixture(source) {
  let now = 0;
  let serial = 0;
  let registrations = 0;
  const timers = new Map();
  const observers = new Set();
  const walks = [];
  const storage = new Map([
    ["postman-zh-misses-v1", '{"Previous untranslated label":{"count":3,"where":"button"}}'],
    ["fixture-preference", "keep-existing-value"]
  ]);
  const storageAccesses = [];
  const localStorage = {
    getItem(key) { storageAccesses.push({ method: "getItem", key }); return storage.get(key) ?? null; },
    setItem(key, value) { storageAccesses.push({ method: "setItem", key }); storage.set(key, String(value)); },
    removeItem(key) { storageAccesses.push({ method: "removeItem", key }); storage.delete(key); },
    clear() { storageAccesses.push({ method: "clear" }); storage.clear(); }
  };
  let document;

  function record(mutation) {
    for (const observer of observers) {
      const { root, options } = observer;
      if (!root || !(root === mutation.target || (options.subtree && root.contains(mutation.target)))) continue;
      if (!options[mutation.type]) continue;
      if (mutation.type === "attributes" && options.attributeFilter && !options.attributeFilter.includes(mutation.attributeName)) continue;
      observer.records.push(mutation);
    }
  }

  function matches(node, selector) {
    const clauses = selector.split(/,(?![^[]*\])/);
    return clauses.some(clause => {
      const pieces = clause.trim().split(/\s+(?![^[]*\])/);
      function compound(el, part) {
        if (!el || el.nodeType !== 1) return false;
        let ok = true;
        const rest = part.replace(/\[([\w-]+)(?:([*^$]?=)["']?([^\]"']*)["']?)?\]/g, (_m, name, op, value) => {
          const attr = el.getAttribute(name);
          if (attr === null || (op === "=" && attr !== value) || (op === "*=" && !attr.includes(value)) ||
              (op === "^=" && !attr.startsWith(value)) || (op === "$=" && !attr.endsWith(value))) ok = false;
          return "";
        });
        if (!ok) return false;
        const tag = rest.match(/^[A-Za-z][\w-]*/);
        if (tag && el.tagName !== tag[0].toUpperCase()) return false;
        for (const part of rest.matchAll(/([.#])([\w-]+)/g)) {
          if (part[1] === "#" ? el.id !== part[2] : !el.className.split(/\s+/).includes(part[2])) return false;
        }
        return true;
      }
      let current = node;
      if (!compound(current, pieces.pop())) return false;
      while (pieces.length) {
        const part = pieces.pop();
        current = current.parentElement;
        while (current && !compound(current, part)) current = current.parentElement;
        if (!current) return false;
      }
      return true;
    });
  }

  class Node {
    constructor(type) { this.nodeType = type; this.parentNode = null; this.childNodes = []; this.ownerDocument = document || null; }
    get parentElement() { return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null; }
    get children() { return this.childNodes.filter(node => node.nodeType === 1); }
    get firstChild() { return this.childNodes[0] || null; }
    get previousSibling() { return this.parentNode ? this.parentNode.childNodes[this.parentNode.childNodes.indexOf(this) - 1] || null : null; }
    get nextSibling() { return this.parentNode ? this.parentNode.childNodes[this.parentNode.childNodes.indexOf(this) + 1] || null : null; }
    get isConnected() { return this.nodeType === 9 || !!((this.parentNode || this.host)?.isConnected); }
    get textContent() { return this.childNodes.map(child => child.textContent).join(""); }
    set textContent(value) {
      const removedNodes = this.childNodes.slice();
      for (const child of removedNodes) child.parentNode = null;
      this.childNodes = [];
      if (String(value)) { const child = new Text(String(value)); child.parentNode = this; child.ownerDocument = this.ownerDocument; this.childNodes.push(child); }
      record({ type: "childList", target: this, addedNodes: this.childNodes.slice(), removedNodes });
    }
    appendChild(child) {
      if (child.parentNode) child.parentNode.removeChild(child);
      child.parentNode = this;
      const adopt = node => { node.ownerDocument = this.nodeType === 9 ? this : this.ownerDocument; node.childNodes.forEach(adopt); };
      adopt(child);
      this.childNodes.push(child);
      record({ type: "childList", target: this, addedNodes: [child], removedNodes: [] });
      return child;
    }
    removeChild(child) {
      const at = this.childNodes.indexOf(child); assert.ok(at >= 0);
      this.childNodes.splice(at, 1); child.parentNode = null;
      record({ type: "childList", target: this, addedNodes: [], removedNodes: [child] });
      return child;
    }
    contains(node) { for (; node; node = node.parentNode) if (node === this) return true; return false; }
    getRootNode() { let node = this; while (node.parentNode) node = node.parentNode; return node; }
    querySelectorAll(selector) {
      const nodes = [];
      const visit = node => { for (const child of node.childNodes) { if (matches(child, selector)) nodes.push(child); visit(child); } };
      visit(this); return nodes;
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  }

  class Text extends Node {
    constructor(value) { super(3); this.value = value; }
    get nodeValue() { return this.value; }
    set nodeValue(value) { this.value = String(value); record({ type: "characterData", target: this }); }
    get textContent() { return this.value; }
    set textContent(value) { this.nodeValue = value; }
  }

  class Element extends Node {
    constructor(tag) { super(1); this.tagName = tag.toUpperCase(); this.attributes = new Map(); this.events = new Map(); this.style = {}; }
    get id() { return this.getAttribute("id") || ""; }
    set id(value) { this.setAttribute("id", value); }
    get className() { return this.getAttribute("class") || ""; }
    set className(value) { this.setAttribute("class", value); }
    get innerText() { return this.textContent; }
    get src() { return this.getAttribute("src") || ""; }
    set src(value) { this.setAttribute("src", value); }
    get placeholder() { return this.getAttribute("placeholder") || ""; }
    set placeholder(value) { this.setAttribute("placeholder", value); }
    get alt() { return this.getAttribute("alt") || ""; }
    set alt(value) { this.setAttribute("alt", value); }
    matches(selector) { return matches(this, selector); }
    closest(selector) { for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node; return null; }
    setAttribute(name, value) { this.attributes.set(name, String(value)); record({ type: "attributes", target: this, attributeName: name }); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    hasAttribute(name) { return this.attributes.has(name); }
    removeAttribute(name) { if (this.attributes.delete(name)) record({ type: "attributes", target: this, attributeName: name }); }
    addEventListener(name, fn) { if (!this.events.has(name)) this.events.set(name, []); this.events.get(name).push(fn); }
    dispatchEvent(event) { for (const fn of this.events.get(event.type) || []) fn(event); return true; }
    attachShadow(options) {
      const root = new Node(11); root.host = this; root.ownerDocument = this.ownerDocument;
      if (options.mode === "open") this.shadowRoot = root;
      return root;
    }
  }
  class Input extends Element { constructor() { super("input"); this._value = ""; } get value() { return this._value; } set value(value) { this._value = String(value); } }
  class Textarea extends Element { constructor() { super("textarea"); this._value = ""; } get value() { return this._value; } set value(value) { this._value = String(value); } }

  document = new Node(9);
  document.ownerDocument = document;
  document.defaultView = { frameElement: null };
  document.readyState = "loading";
  document.events = new Map();
  document.addEventListener = Element.prototype.addEventListener;
  document.dispatchEvent = Element.prototype.dispatchEvent;
  document.createElement = tag => tag.toLowerCase() === "input" ? new Input() : tag.toLowerCase() === "textarea" ? new Textarea() : new Element(tag);
  document.createTextNode = value => new Text(String(value));
  document.getElementById = id => document.querySelector("#" + id);
  document.documentElement = document.appendChild(new Element("html"));
  document.head = document.documentElement.appendChild(new Element("head"));
  document.body = document.documentElement.appendChild(new Element("body"));
  document.createTreeWalker = (root, mask, filter) => {
    walks.push({ root, mask });
    const nodes = [];
    const visit = node => {
      const shown = (mask & (node.nodeType === 3 ? 4 : node.nodeType === 1 ? 1 : 0)) !== 0;
      const decision = shown && filter ? filter.acceptNode(node) : 1;
      if (decision === 2) return;
      if (shown && decision === 1) nodes.push(node);
      for (const child of node.childNodes) visit(child);
    };
    for (const child of root.childNodes) visit(child);
    let index = 0;
    return { currentNode: root, nextNode() { this.currentNode = nodes[index++] || null; return this.currentNode; } };
  };

  class MutationObserver {
    constructor(callback) { this.callback = callback; this.records = []; }
    observe(root, options) { this.root = root; this.options = options; observers.add(this); }
    disconnect() { observers.delete(this); this.records = []; }
  }
  const setTimeout = (fn, delay) => { const id = ++serial; registrations++; timers.set(id, { fn, at: now + delay, delay }); return id; };
  const clearTimeout = id => timers.delete(id);
  class ClockDate extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const context = vm.createContext({
    window: { localStorage }, localStorage,
    document, Element, HTMLInputElement: Input, HTMLTextAreaElement: Textarea,
    Event: class Event { constructor(type) { this.type = type; } }, MutationObserver,
    NodeFilter: { SHOW_TEXT: 4, SHOW_ELEMENT: 1, FILTER_REJECT: 2, FILTER_ACCEPT: 1, FILTER_SKIP: 3 },
    Date: ClockDate, setTimeout, clearTimeout, navigator: {}, console
  });
  const boot = source.lastIndexOf("\n  installShadowRootLocalization();");
  assert.ok(boot > source.indexOf("window.__POSTMAN_ZH_LOCALIZER__ ="));
  vm.runInContext(source.slice(0, boot) + `
    globalThis.fixtureApi = {
      handleMutations, observe, forceGlobalSearchSpecialText, forceRequestTypeSpecialText,
      fixForceCloseConfirmParagraphs, fixCompositeTextBlocks, fixPerformanceCompositeText,
      canTranslateTextNode, canTranslateAttributes, canRewriteCompositeText,
      patchLocale,
      translateEditableValues, patchEditableValueSetters, installEditableValueListeners, installShadowRootLocalization,
      scheduleEditableValueSweep, scheduleWalkRetries, createTranslationPhase, scheduleTranslationPhase,
      walkRetryPhases, editableValueSweepPhase
    };
  })();`, context, { filename: "zh-localize-runtime-fixture.js", timeout: 10000 });
  const api = context.fixtureApi;
  const localizer = context.window.__POSTMAN_ZH_LOCALIZER__;
  const flushMutations = () => {
    let rounds = 0;
    while ([...observers].some(observer => observer.records.length)) {
      assert.ok(++rounds < 100, "Observer 应在有限轮次内稳定");
      for (const observer of observers) {
        if (!observer.records.length) continue;
        const records = observer.records; observer.records = []; observer.callback(records);
      }
    }
    return rounds;
  };
  return {
    api, localizer, document, timers, walks, storage, storageAccesses, flushMutations,
    registrations: () => registrations,
    el(tag = "div", text = "", parent = document.body) {
      const el = document.createElement(tag); if (text) el.textContent = text;
      if (parent) parent.appendChild(el); return el;
    },
    advance(ms) {
      const until = now + ms; let steps = 0;
      for (;;) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!next || next[1].at > until) break;
        assert.ok(++steps < 10000, "阶段调度应在有限步数内完成");
        now = next[1].at; timers.delete(next[0]); next[1].fn(); flushMutations();
      }
      now = until; flushMutations();
    }
  };
}

async function runLocalizationRuntimeTests() {
  const source = fs.readFileSync(path.join(__dirname, "../../payload/zh-localize.js"), "utf8").replace(/\r\n/g, "\n");
  let passed = 0;
  const failures = [];
  const test = (name, fn) => { try { fn(fixture(source)); passed++; } catch (error) { failures.push({ name, error: error.message }); } };

  test("公开接口仅保留 run、translate、walk", r => {
    assert.deepEqual(Object.keys(r.localizer).sort(), ["run", "translate", "walk"]);
  });
  test("漏翻正文、属性及异步更新不再读取或写入存储", r => {
    const before = [...r.storage];
    const label = r.el("div", "Uncatalogued guidance for repeated placeholder text.");
    label.setAttribute("title", "Another uncatalogued instruction for this fixture.");
    const translated = r.el("span", "Save");
    r.api.observe(); r.localizer.walk(r.document.body); r.flushMutations();
    label.textContent = "A newly rendered uncatalogued description.";
    label.setAttribute("title", "Another newly rendered uncatalogued description.");
    r.advance(2500);
    assert.equal(translated.textContent, "保存");
    assert.equal(label.textContent, "A newly rendered uncatalogued description.");
    assert.equal(label.getAttribute("title"), "Another newly rendered uncatalogued description.");
    assert.deepEqual(r.storageAccesses, []);
    assert.deepEqual([...r.storage], before);
    assert.equal(r.timers.size, 0);
  });
  test("保留区域设置写入，旧收集记录与其他存储逐字保持", r => {
    const before = [...r.storage];
    r.api.patchLocale();
    assert.deepEqual(r.storageAccesses, [
      { method: "setItem", key: "postman:locale" },
      { method: "setItem", key: "locale" },
      { method: "setItem", key: "language" }
    ]);
    for (const [key, value] of before) assert.equal(r.storage.get(key), value);
    for (const key of ["postman:locale", "locale", "language"]) assert.equal(r.storage.get(key), "zh-CN");
  });
  test("Selected 在键值数据区的文本和属性均保持原样", r => {
    const cell = r.el("div", "Selected"); cell.className = "key-value-cell"; cell.setAttribute("title", "Selected");
    r.localizer.walk(cell); r.advance(700);
    assert.equal(cell.textContent, "Selected"); assert.equal(cell.getAttribute("title"), "Selected");
  });
  test("普通界面的 Selected 与菜单 HTTP 继续翻译", r => {
    const label = r.el("span", "Selected"); label.setAttribute("title", "Selected");
    const menu = r.el("div", "HTTP"); menu.setAttribute("role", "menuitem");
    r.localizer.walk(r.document.body);
    assert.equal(label.textContent, "已选择"); assert.equal(label.getAttribute("title"), "已选择");
    assert.equal(menu.textContent, "HTTP 请求");
  });
  test("编辑器正文与 placeholder 属性采用不同保护规则", r => {
    const editor = r.el("div", "Selected"); editor.setAttribute("contenteditable", "true"); editor.setAttribute("data-placeholder", "Selected");
    const input = r.el("input"); input.setAttribute("placeholder", "Selected");
    r.localizer.walk(r.document.body);
    assert.equal(editor.textContent, "Selected"); assert.equal(editor.getAttribute("data-placeholder"), "已选择");
    assert.equal(input.getAttribute("placeholder"), "已选择");
  });
  test("所有组合修补都保留代码及响应正文", r => {
    for (const kind of ["code", "pre", "response"]) {
      const wrapper = r.el("div"); const code = r.el(kind === "response" ? "div" : kind, "Explore GraphQL with Postman", wrapper);
      if (kind === "response") code.className = "response-body";
      r.api.forceRequestTypeSpecialText(wrapper); r.api.forceGlobalSearchSpecialText(wrapper);
      assert.equal(code.textContent, "Explore GraphQL with Postman"); assert.equal(wrapper.firstChild, code);
      code.textContent = "Run all requests in your collections to efficiently test your endpoints.";
      r.api.fixCompositeTextBlocks(wrapper); r.api.fixPerformanceCompositeText(wrapper);
      assert.equal(wrapper.firstChild, code); assert.match(code.textContent, /^Run all requests/);
    }
  });
  test("强制关闭和性能组合文案同样保护键值数据区", r => {
    const cell = r.el("div"); cell.className = "key-value-cell";
    const p = r.el("p", "2 tabs have unsaved changes which will be lost if you force close these tabs.", cell);
    r.api.fixForceCloseConfirmParagraphs(cell); assert.match(p.textContent, /^2 tabs have/);
    p.textContent = "Total requests sent"; r.api.fixPerformanceCompositeText(cell); assert.equal(p.textContent, "Total requests sent");
    p.textContent = "Run all requests in your collections to efficiently test your endpoints.";
    r.api.fixCompositeTextBlocks(cell); assert.match(p.textContent, /^Run all requests/);
  });
  test("键值表头与菜单仍属于界面而非用户数据", r => {
    const row = r.el("div"); row.className = "key-value-form-row";
    const header = r.el("div", "Key", row); header.className = "header-row";
    const hint = r.el("div", "Value", row); hint.className = "key-value-cell__placeholder";
    r.localizer.walk(row);
    assert.equal(header.textContent, "键"); assert.equal(hint.textContent, "值");
  });
  test("输入值扫描和原型 setter 均保留键值数据", r => {
    const cell = r.el("div"); cell.className = "key-value-cell";
    const data = r.el("input", "", cell); const name = r.el("input");
    data.value = "New Environment"; name.value = "New Environment";
    r.api.translateEditableValues(r.document.body);
    assert.equal(data.value, "New Environment"); assert.equal(name.value, "新建环境");
    r.api.patchEditableValueSetters();
    data.value = "Lab's fork"; name.value = "Lab's fork";
    assert.equal(data.value, "Lab's fork"); assert.equal(name.value, "Lab 的派生");
  });
  test("先设置 value 后挂载的 React 输入框按落位后的上下文判断", r => {
    r.api.patchEditableValueSetters();
    const cell = r.el("div"); cell.className = "key-value-cell";
    const data = r.el("input", "", null); const name = r.el("input", "", null);
    data.value = name.value = "New Environment";
    assert.equal(data.value, "New Environment"); assert.equal(name.value, "New Environment");
    cell.appendChild(data); r.document.body.appendChild(name); r.localizer.walk(r.document.body);
    assert.equal(data.value, "New Environment"); assert.equal(name.value, "新建环境");
  });
  test("编辑器 value 扫描与 textarea 默认正文保留，placeholder 仍翻译", r => {
    for (const className of ["monaco-editor", "CodeMirror", "response-body"]) {
      const editor = r.el("div"); editor.className = className;
      const field = r.el("textarea", "New Environment", editor); field.value = "New Environment";
      field.setAttribute("placeholder", "Selected"); field.setAttribute("data-placeholder", "Selected");
      r.api.translateEditableValues(editor); r.localizer.walk(editor); r.advance(700);
      assert.equal(field.value, "New Environment"); assert.equal(field.textContent, "New Environment");
      assert.equal(field.getAttribute("placeholder"), "已选择"); assert.equal(field.getAttribute("data-placeholder"), "已选择");
    }
  });
  test("编辑器内 input 与 textarea 的原型 setter 保留用户 value", r => {
    r.api.patchEditableValueSetters(); const editor = r.el("div"); editor.className = "monaco-editor";
    for (const tag of ["input", "textarea"]) {
      const data = r.el(tag, "", editor); const name = r.el(tag);
      data.value = name.value = "New Environment";
      assert.equal(data.value, "New Environment"); assert.equal(name.value, "新建环境");
      data.value = name.value = "Lab's fork";
      assert.equal(data.value, "Lab's fork"); assert.equal(name.value, "Lab 的派生");
    }
  });
  test("编辑器 Shadow 宿主同时保护 value 扫描及原型 setter", r => {
    const editor = r.el("div"); editor.className = "monaco-editor";
    const shadow = editor.attachShadow({ mode: "open" });
    const field = r.el("textarea", "New Environment", shadow); field.value = "New Environment"; field.setAttribute("placeholder", "Selected");
    r.api.translateEditableValues(shadow); r.localizer.walk(shadow);
    assert.equal(field.value, "New Environment"); assert.equal(field.textContent, "New Environment");
    assert.equal(field.getAttribute("placeholder"), "已选择");
    r.api.patchEditableValueSetters(); field.value = "Lab's fork"; assert.equal(field.value, "Lab's fork");
    r.advance(700); assert.equal(field.value, "Lab's fork");
  });
  test("旧版误翻的运行时占位仍可恢复英文", r => {
    const cell = r.el("div", "<运行时计算>"); cell.className = "key-value-cell";
    r.localizer.walk(cell); assert.equal(cell.textContent, "<calculated at runtime>");
  });
  test("一批 100 个新增节点只注册 8 个阶段计时器", r => {
    const nodes = Array.from({ length: 100 }, () => r.el("div", "Save"));
    r.api.handleMutations([{ type: "childList", target: r.document.body, addedNodes: nodes }]);
    assert.equal(r.timers.size, 8); assert.equal(r.registrations(), 8);
    assert.ok(nodes.every(node => node.textContent === "保存"));
    r.advance(700); assert.equal(r.timers.size, 0);
  });
  test("同批父子新增与重复属性记录只完整遍历父节点一次", r => {
    const parent = r.el("div"); const child = r.el("span", "Save", parent); child.setAttribute("title", "Selected");
    r.api.handleMutations([
      { type: "childList", target: r.document.body, addedNodes: [parent] },
      { type: "childList", target: parent, addedNodes: [child] },
      { type: "attributes", target: child, attributeName: "title" },
      { type: "attributes", target: child, attributeName: "title" }
    ]);
    assert.deepEqual(r.walks.filter(walk => walk.mask === 5).map(walk => walk.root), [parent]);
    assert.equal(child.textContent, "保存"); assert.equal(child.getAttribute("title"), "已选择");
    assert.equal(r.timers.size, 8);
  });
  test("延迟任务跳过已脱离文档的节点", r => {
    const root = r.el("div"); r.localizer.walk(root); r.document.body.removeChild(root);
    root.textContent = "Total requests sent"; r.advance(700);
    assert.equal(root.textContent, "Total requests sent"); assert.equal(r.timers.size, 0);
  });
  test("晚加入的兄弟输入框保留自己的 60 毫秒重试窗口", r => {
    const first = r.el("input"); const later = r.el("input"); first.value = later.value = "New Environment";
    r.api.scheduleEditableValueSweep(first); r.advance(50); r.api.scheduleEditableValueSweep(later);
    assert.equal(r.timers.size, 1); r.advance(10);
    assert.equal(first.value, "新建环境"); assert.equal(later.value, "New Environment");
    r.advance(50); assert.equal(later.value, "新建环境"); assert.equal(r.timers.size, 0);
  });
  test("同一根重复排队既按首次期限执行也保留末次重试", r => {
    const field = r.el("input"); field.value = "New Environment";
    r.api.scheduleEditableValueSweep(field); r.advance(50); r.api.scheduleEditableValueSweep(field);
    r.advance(10); assert.equal(field.value, "新建环境");
    field.value = "New Environment"; r.advance(49); assert.equal(field.value, "New Environment");
    r.advance(1); assert.equal(field.value, "新建环境"); assert.equal(r.timers.size, 0);
  });
  test("延迟父节点合并子节点时保留前后两个期限", r => {
    const parent = r.el("div"); const child = r.el("span", "", parent); const calls = [];
    const phase = r.api.createTranslationPhase(60, root => calls.push(root));
    r.api.scheduleTranslationPhase(phase, child); r.advance(50); r.api.scheduleTranslationPhase(phase, parent);
    assert.equal(phase.roots.size, 1); assert.equal(r.timers.size, 1);
    r.advance(10); assert.deepEqual(calls, [parent]); r.advance(50); assert.deepEqual(calls, [parent, parent]);
  });
  test("阶段执行期间再次排队不会丢失或叠加计时器", r => {
    const root = r.el("div"); let calls = 0;
    const phase = r.api.createTranslationPhase(20, () => { if (++calls === 1) r.api.scheduleTranslationPhase(phase, root); });
    r.api.scheduleTranslationPhase(phase, root); r.advance(20);
    assert.equal(calls, 1); assert.equal(r.timers.size, 1); r.advance(20);
    assert.equal(calls, 2); assert.equal(r.timers.size, 0);
  });
  test("连续点击与输入事件复用阶段而非按次数创建计时器", r => {
    const input = r.el("input"); input.value = "New Environment"; r.document.activeElement = input;
    r.api.installEditableValueListeners();
    for (let i = 0; i < 100; i++) {
      r.document.dispatchEvent({ type: "click" }); r.document.dispatchEvent({ type: "input" });
    }
    assert.equal(r.timers.size, 5); assert.equal(r.registrations(), 5);
    assert.equal(input.value, "新建环境"); r.advance(1000); assert.equal(r.timers.size, 0);
  });
  test("性能分片文案保留 80 和 260 毫秒 React 重试", r => {
    const root = r.el("div"); r.localizer.walk(root); r.advance(50);
    root.appendChild(r.document.createTextNode("Total requests ")); root.appendChild(r.document.createTextNode("sent"));
    r.advance(30); assert.equal(root.textContent.trim(), "已发送请求总数");
    root.textContent = "Total requests sent"; r.advance(179); assert.equal(root.textContent, "Total requests sent");
    r.advance(1); assert.equal(root.textContent, "已发送请求总数");
  });
  test("输入占位的晚渲染仍由 180 毫秒特殊修补覆盖", r => {
    const input = r.el("input"); r.localizer.walk(input); r.advance(100);
    input.setAttribute("placeholder", "Search Postman (append > to see and run commands)");
    r.advance(80); assert.equal(input.getAttribute("placeholder"), "搜索 Postman（输入 > 查看并运行命令）");
  });
  test("真实 Observer 处理异步属性并在自身写入后稳定", r => {
    const input = r.el("input"); r.api.observe(); input.setAttribute("placeholder", "Selected");
    assert.ok(r.flushMutations() <= 3); assert.equal(input.getAttribute("placeholder"), "已选择");
    r.advance(700); assert.equal(r.timers.size, 0);
  });
  test("异步分片组合文案在一批文字变动后完成整句拼装", r => {
    const root = r.el("p"); r.api.observe();
    root.appendChild(r.document.createTextNode("Team Members"));
    root.appendChild(r.document.createTextNode(" are part of "));
    root.appendChild(r.document.createTextNode("Runtime team"));
    r.flushMutations(); assert.equal(root.textContent, "团队成员属于 Runtime 团队");
  });
  test("open ShadowRoot 初始与异步文本属性均被翻译", r => {
    r.api.installShadowRootLocalization(); const host = r.el("div"); const shadow = host.attachShadow({ mode: "open" });
    const label = r.el("span", "Selected", shadow); label.setAttribute("title", "Selected"); r.advance(0);
    assert.equal(label.textContent, "已选择"); assert.equal(label.getAttribute("title"), "已选择");
    const later = r.el("span", "Save", shadow); r.flushMutations(); assert.equal(later.textContent, "保存");
  });
  test("ShadowRoot 的保护判断继承键值区宿主", r => {
    r.api.installShadowRootLocalization(); const host = r.el("div"); host.className = "key-value-cell";
    const shadow = host.attachShadow({ mode: "open" });
    shadow.appendChild(r.document.createTextNode("Selected"));
    const label = r.el("span", "Selected", shadow); label.setAttribute("title", "Selected");
    r.advance(700); assert.equal(shadow.textContent, "SelectedSelected"); assert.equal(label.getAttribute("title"), "Selected");
  });
  test("closed ShadowRoot 队列不被宿主父节点错误吞并", r => {
    const host = r.el("div"); const shadow = host.attachShadow({ mode: "closed" }); const calls = [];
    const phase = r.api.createTranslationPhase(20, root => calls.push(root));
    r.api.scheduleTranslationPhase(phase, shadow); r.api.scheduleTranslationPhase(phase, r.document.body);
    assert.equal(phase.roots.size, 2); assert.equal(r.timers.size, 1); r.advance(20);
    assert.deepEqual(calls, [shadow, r.document.body]);
  });
  test("动态占位与半译闸门不因调度重构而变化", r => {
    assert.equal(r.localizer.translate("  Save\n"), "  保存\n");
    assert.equal(r.localizer.translate("Uncatalogued guidance for repeated placeholder text."), "Uncatalogued guidance for repeated placeholder text.");
    assert.equal(r.localizer.translate("Add an unrecognized custom widget"), "Add an unrecognized custom widget");
  });

  if (failures.length) throw new Error("翻译运行时回归失败：" + failures.map(item => item.name + "（" + item.error + "）").join("；"));
  return { passed, failures };
}

module.exports = { runLocalizationRuntimeTests };
