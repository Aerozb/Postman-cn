"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

// 按需诊断产物仅写入仓库同级 _generated，不接受任意输出目录。
const DIAGNOSTIC_GENERATED_DIR = path.resolve(__dirname, "..", "..", "..", "_generated");
const OUTPUT_EXTENSIONS = new Set([".json", ".png"]);

function ensureGeneratedDir() {
  fs.mkdirSync(DIAGNOSTIC_GENERATED_DIR, { recursive: true });
  let stat;
  try {
    stat = fs.lstatSync(DIAGNOSTIC_GENERATED_DIR);
  } catch (error) {
    throw new Error(`无法访问项目同级 _generated 目录：${error.message}`);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("项目同级 _generated 必须是普通目录，不能是符号链接或其他文件。 ");
  }
}

function validateOutputName(value, fallback = "diagnostic-report") {
  const requested = value == null || value === "" ? fallback : String(value).trim();
  if (!requested || requested.startsWith("--")) {
    throw new Error("--out 后必须提供文件名。只能使用 _generated 下的文件名。 ");
  }
  // A filename must not contain either platform's separator. This also covers
  // absolute POSIX paths, UNC paths and Windows drive paths consistently.
  if (
    requested.includes("/") ||
    requested.includes("\\") ||
    requested.includes(":") ||
    path.isAbsolute(requested) ||
    /^[A-Za-z]:/.test(requested) ||
    requested.includes("\0") ||
    requested === "." ||
    requested === ".." ||
    requested.includes("..") ||
    /[\u0000-\u001f\u007f]/.test(requested)
  ) {
    throw new Error("--out 只能使用单个文件名，不能包含目录、绝对路径或路径穿越。 ");
  }
  const extension = path.extname(requested).toLowerCase();
  if (extension && !OUTPUT_EXTENSIONS.has(extension)) {
    throw new Error("--out 文件名只能使用 .json 或 .png 扩展名。 ");
  }
  return requested;
}

function resolveDiagnosticOutputPath(value, fallback = "diagnostic-report.json") {
  const requested = validateOutputName(value, fallback);
  const extension = path.extname(requested).toLowerCase();
  // Reports are JSON. A .png --out value is accepted as a convenient base
  // name and normalized to the corresponding JSON report path.
  const filename = extension === ".png"
    ? `${requested.slice(0, -4)}.json`
    : extension
      ? requested
      : `${requested}.json`;
  ensureGeneratedDir();
  return path.join(DIAGNOSTIC_GENERATED_DIR, filename);
}

// 仅保留定位问题所需的短文本和计数；页面、请求与输入数据先脱敏。

// 这些字段可能直接携带请求/响应正文、输入值、认证信息或 CDP 内部对象。
// 数字和布尔值仍由 sanitizeValue 保留，避免丢掉状态码、计数等汇总信息。
const DROP_KEYS = /^(?:webSocketDebuggerUrl|websocket|browserPath|sampleText|bodyPreview|bodyText|body|rawBody|postData|postDataEntries|payload|requestPayload|responsePayload|requestBody|responseBody|inputValue|inputValues|formData|formEntries|targetPreview|combinedText|innerText|outerText|textContent|value|headers|requestHeaders|responseHeaders|cookies|authorization|proxyAuthorization|token|idToken|accessToken|refreshToken|secret|password|clientSecret|apiKey|queryParams|searchParams|stack|exceptionDetails|targetId|parentId|openerId|sessionId)$/i;
const DROP_COLLECTIONS = new Set(["log", "snapshots", "actions", "entries", "axEntries", "overlays", "targets", "targetPreview", "errors"]);
const PATH_KEYS = /^(?:path|filePath|portFile|sourcePath|directory|directoryPath|rootPath|cwd|workingDirectory|workspacePath|screenshotPath)$/i;
const OUTPUT_PATH_KEYS = /^(?:out|screenshot)$/i;
const KEEP_FINDING_KEYS = new Set([
  "text", "key", "kind", "attribute", "tag", "role", "count"
]);

const ABSOLUTE_URL_PATTERN = /\b(?:https?|wss?|ws|file):\/\/[^\s"'<>]+/gi;
const RELATIVE_QUERY_PATTERN = /(^|[\s("'=])((?:\.{0,2}\/|\/)[^\s"'<>?#]*)[?#][^\s"'<>]*/g;
const QUOTED_LOCAL_PATH_PATTERN = /(["'`])((?:[A-Za-z]:[\\/]|\\\\|\/(?:Users|home|root|tmp|private|var|opt|srv|mnt|Volumes|workspace|workspaces)(?:\/|$))[^\r\n]*?)\1/g;
const PAREN_LOCAL_PATH_PATTERN = /(\()((?:[A-Za-z]:[\\/]|\\\\|\/(?:Users|home|root|tmp|private|var|opt|srv|mnt|Volumes|workspace|workspaces)(?:\/|$))[^\r\n)]*)(\))/g;
const UNC_PATH_PATTERN = /\\\\[^,;'"<>{}\[\]|)\r\n]+/g;
const WINDOWS_PATH_PATTERN = /(?<![\\/:A-Za-z0-9])\b[A-Za-z]:[\\/][^,;'"<>{}\[\]|)\r\n]+/g;
const UNIX_PATH_PATTERN = /(^|[^\w:])\/(?:Users|home|root|tmp|private|var\/(?:tmp|folders|log)|opt|srv|mnt|Volumes|workspace|workspaces)(?:\/[^\s,;'"<>{}\[\]|)]+)+/g;
const PURE_ROLE_PATTERN = /^(?:button|menuitem|menuitemcheckbox|menuitemradio|generic|statictext|image|searchbox|textbox|combobox|listbox|option|tab|tabpanel|treeitem|checkbox|radio|switch|link|dialog|tooltip)$/i;
const TEST_IDENTIFIER_PATTERN = /^(?:aether(?:[-_:][a-z0-9_.:/-]+)+|request-editor-tab--[a-z0-9_.:-]+|env-filter-select-trigger-[a-z0-9_.:-]+)$/i;
const FILE_NAME_PATTERN = /^(?!https?:\/\/)[^\s\\/:*?"<>|]{1,180}\.(?:md|markdown|txt|json|ya?ml|toml|ini|csv|tsv|xml|html?|css|scss|sass|less|js|jsx|mjs|cjs|ts|tsx|py|java|go|rs|rb|php|sh|ps1|bat|cmd|sql|graphql|proto|pdf|png|jpe?g|gif|webp|svg|zip|7z|tar|gz|postman_collection|postman_environment)$/i;
const TECHNICAL_TERM_PATTERN = /\b(?:Postman|Playwright|Newman|REST|SOAP|API|APIs|HTTP|HTTPS|JSON|XML|OAuth|GraphQL|gRPC|WebSocket|Cookie|RBAC|SSE|TLS|SSL|TCP|UDP|DNS|MCP|MQTT|Git|PR|URL|URI|HTML|CSS|JavaScript|TypeScript)\b/gi;
const SHORTCUT_PATTERN = /\b(?:Ctrl|Alt|Shift|Cmd|Command|Option|Meta)(?:\s*\+\s*(?:[A-Z0-9,./;='\[\]\\-]|F\d{1,2}|Left|Right|Up|Down|Enter|Escape|Tab|Space|Backspace|Delete|左方向键|右方向键|上方向键|下方向键)){1,4}(?=$|[^A-Za-z0-9])/gi;
const HTTP_METHOD_PATTERN = /\b(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE|CONNECT)\b/g;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

function normalizedCandidateText(value) {
  return String(value == null ? "" : value).replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function validIdentityHint(value) {
  const text = normalizedCandidateText(value).replace(/^["'`]|["'`]$/g, "");
  if (!text || text.length > 80 || PURE_ROLE_PATTERN.test(text) || TEST_IDENTIFIER_PATTERN.test(text)) return "";
  if (/[{};<>\r\n]/.test(text) || /^(?:Postman|Git|API|APIs|Microsoft Teams)$/i.test(text)) return "";
  return text;
}

function addIdentityHint(hints, value) {
  const text = validIdentityHint(value);
  if (text && hints.size < 80) hints.add(text);
}

function collectIdentityHints(value) {
  const hints = new Set();
  const seen = new WeakSet();
  let visited = 0;
  const visit = (item) => {
    if (visited++ >= 50000 || item == null) return;
    if (Array.isArray(item)) {
      for (const entry of item) visit(entry);
      return;
    }
    if (typeof item !== "object" || seen.has(item)) return;
    seen.add(item);
    const text = normalizedCandidateText(item.text || item.name || item.label || "");
    if (text) {
      let match = text.match(/^(.{1,80}?)\s*(?:的头像|团队标志)$/i) || text.match(/^(.{1,80}?)\s+(?:avatar|team logo)$/i);
      if (match) addIdentityHint(hints, match[1]);
      match = text.match(/^([^,，。；;!?！？]{1,80}?)\s*[（(](?:你|you)[）)](?:\s|$)/i);
      if (match) addIdentityHint(hints, match[1]);
      match = text.match(/^([a-z][a-z0-9._-]{2,63})\s*[,，]\s*(?:你(?:今天|好|想|要|可以|是否|的)|欢迎)/);
      if (match) addIdentityHint(hints, match[1]);
      match = text.match(/(?:^|\s)([A-Za-z0-9][A-Za-z0-9._-]{1,63})\s+[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/);
      if (match) addIdentityHint(hints, match[1]);
      for (const email of text.match(EMAIL_PATTERN) || []) addIdentityHint(hints, email);
      match = text.match(/(?:^|\s)([A-Za-z0-9][A-Za-z0-9._-]{2,79})\s+(?:企业版|团队|套餐|工作区)(?:\s|$|[（(])/);
      if (match) addIdentityHint(hints, match[1]);
      const attribute = String(item.attribute || "").toLowerCase();
      if (attribute === "alt" && /^[A-Za-z0-9][A-Za-z0-9._-]{2,79}$/.test(text) && /(?:[-_.].*\d|\d.*[-_.])/.test(text)) {
        addIdentityHint(hints, text);
      }
    }
    for (const child of Object.values(item)) visit(child);
  };
  visit(value);
  return hints;
}

function looksLikeCssText(text) {
  if (!/[{}]/.test(text)) return false;
  const declarations = text.match(/(?:^|[;{]\s*)(?:--[a-z0-9_-]+|background(?:-[a-z-]+)?|color|display|position|font(?:-[a-z-]+)?|border(?:-[a-z-]+)?|margin(?:-[a-z-]+)?|padding(?:-[a-z-]+)?|width|height|opacity|transform|transition|align-items|justify-content)\s*:/gi) || [];
  return declarations.length > 0 && /\}/.test(text);
}

function replaceTracked(value, pattern, replacement, state) {
  const next = value.replace(pattern, replacement);
  if (next !== value) state.removed = true;
  return next;
}

function stripKnownIdentity(value, identity, state) {
  const escaped = identity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const asciiBounded = /^[A-Za-z0-9_]/.test(identity) && /[A-Za-z0-9_]$/.test(identity);
  const pattern = asciiBounded
    ? new RegExp(`(^|[^A-Za-z0-9_])${escaped}(?=$|[^A-Za-z0-9_])`, "gi")
    : new RegExp(escaped, "gi");
  return replaceTracked(value, pattern, "$1", state);
}

function isDiagnosticNoise(item, identities = new Set()) {
  const text = normalizedCandidateText(item && typeof item === "object" ? item.text : item);
  if (!text) return false;
  const attribute = String(item && typeof item === "object" && item.attribute || "").toLowerCase();
  const kind = String(item && typeof item === "object" && item.kind || "").toLowerCase();
  if (/^(?:button|menuitem)$/i.test(text) || (PURE_ROLE_PATTERN.test(text) && (attribute === "role" || /(?:^|[-_])role(?:$|[-_])/.test(kind))) || TEST_IDENTIFIER_PATTERN.test(text)) return true;
  if ((attribute === "data-testid" || attribute === "data-test-id" || attribute === "data-aether-id" || /(?:test-?id|aether-id)/.test(kind)) && /^[A-Za-z0-9_.:/-]{3,180}$/.test(text)) return true;
  if (FILE_NAME_PATTERN.test(text) || looksLikeCssText(text)) return true;
  const state = { removed: false };
  let remainder = text;
  remainder = replaceTracked(remainder, /^(?:.{1,80}?)\s*(?:的头像|团队标志)$/i, "", state);
  remainder = replaceTracked(remainder, /^(?:.{1,80}?)\s+(?:avatar|team logo)$/i, "", state);
  remainder = replaceTracked(remainder, EMAIL_PATTERN, " ", state);
  for (const identity of [...identities].sort((a, b) => b.length - a.length)) remainder = stripKnownIdentity(remainder, identity, state);
  remainder = replaceTracked(remainder, SHORTCUT_PATTERN, " ", state);
  remainder = replaceTracked(remainder, HTTP_METHOD_PATTERN, " ", state);
  remainder = replaceTracked(remainder, TECHNICAL_TERM_PATTERN, " ", state);
  remainder = normalizedCandidateText(remainder);
  return state.removed && !/[A-Za-z]{2,}/.test(remainder);
}

function sanitizeEmbeddedUrl(value) {
  const raw = String(value == null ? "" : value);
  const trailingMatch = raw.match(/[.,;:!?)}\]，。；：！？]+$/u);
  const trailing = trailingMatch ? trailingMatch[0] : "";
  const core = trailing ? raw.slice(0, -trailing.length) : raw;
  return sanitizeUrl(core) + trailing;
}

function redactSecrets(value) {
  return String(value == null ? "" : value)
    // Header names may be quoted when the source is JSON.
    .replace(/((?:["']?(?:proxy-)?authorization["']?)\s*[:=]\s*)(?:(?:bearer|basic|digest)\s+)?(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi, "$1[已隐藏]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{4,}=*/gi, "Bearer [已隐藏]")
    .replace(/((?:["']?(?:access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|api[_-]?key|token|secret|password)["']?)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi, "$1[已隐藏]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9._-]{8,}\b/g, "[已隐藏]")
    .replace(/\b(?:sk|pk|rk|ghp|github_pat)_[A-Za-z0-9_-]{8,}\b/gi, "[已隐藏]");
}

function redactBodyLikeText(value) {
  const text = String(value == null ? "" : value);
  const trimmed = text.trim();
  if (!trimmed) return text;
  const looksLikeJson = /^(?:\{[\s\S]*\}|\[[\s\S]*\])$/.test(trimmed) && /["'][^"']+["']\s*:/.test(trimmed);
  const looksLikeStructuredBody = /\b(?:request|response)\s*(?:body|payload)|(?:postData|requestBody|responseBody|rawBody|payload)\s*[:=]/i.test(trimmed) && trimmed.length >= 80;
  const looksLikeMarkupBody = /^(?:<\?xml|<!doctype|<html\b)/i.test(trimmed) && trimmed.length >= 120;
  return looksLikeJson || looksLikeStructuredBody || looksLikeMarkupBody ? "[疑似请求/响应正文已隐藏]" : text;
}

function sanitizeLocalPaths(value) {
  return String(value == null ? "" : value)
    .replace(QUOTED_LOCAL_PATH_PATTERN, (_match, quote) => `${quote}[本机路径已隐藏]${quote}`)
    .replace(PAREN_LOCAL_PATH_PATTERN, (_match, open, _path, close) => `${open}[本机路径已隐藏]${close}`)
    .replace(UNC_PATH_PATTERN, "[本机路径已隐藏]")
    .replace(WINDOWS_PATH_PATTERN, "[本机路径已隐藏]")
    .replace(UNIX_PATH_PATTERN, (_match, prefix) => `${prefix}[本机路径已隐藏]`);
}

function cleanText(value, limit = 600) {
  let text = String(value == null ? "" : value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  // 先处理绝对 URL，再处理本机路径，避免把远程 URL 的 pathname 误判成本机目录。
  text = text.replace(ABSOLUTE_URL_PATTERN, sanitizeEmbeddedUrl);
  text = text.replace(RELATIVE_QUERY_PATTERN, (_match, prefix, base) => `${prefix}${base}`);
  text = redactSecrets(text);
  text = sanitizeLocalPaths(text);
  text = redactBodyLikeText(text);
  return text.replace(/\s+/g, " ").trim().slice(0, limit);
}

function sanitizeUrl(value) {
  const raw = String(value == null ? "" : value).trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === "ws:" || parsed.protocol === "wss:") {
      return "[WebSocket 地址已隐藏]";
    }
    // file:// 路径可能暴露本机用户名和目录，只保留协议和固定用途名称。
    if (parsed.protocol === "file:") {
      const path = parsed.pathname.toLowerCase();
      if (/requester\.html(?:$|[?#])/.test(path)) return "file:///…/requester.html";
      if (/scratchpad\.html(?:$|[?#])/.test(path)) return "file:///…/scratchpad.html";
      return "file:///…";
    }
    parsed.search = "";
    parsed.hash = "";
    return `${parsed.origin}${parsed.pathname || "/"}`;
  } catch (_) {
    // 即使不是标准 URL，也不能把 ? 后的账号参数写入报告。
    return raw.replace(/[?#].*$/, "").slice(0, 300);
  }
}

function safeTarget(target) {
  if (!target || typeof target !== "object") return null;
  return {
    type: cleanText(target.type, 40),
    title: cleanText(target.title, 160),
    url: sanitizeUrl(target.url)
  };
}

function compactFinding(item, context) {
  // 字符串与对象形式统一脱敏，避免短文本诊断被静默丢弃。
  if (typeof item === "string") {
    const text = cleanText(item, context.findingTextLimit);
    if (!text) return null;
    return isDiagnosticNoise({ text }, context.identities) ? null : { text };
  }
  if (!item || typeof item !== "object") return null;
  if (isDiagnosticNoise(item, context.identities)) return null;
  const result = {};
  for (const key of KEEP_FINDING_KEYS) {
    if (!(key in item)) continue;
    const value = item[key];
    if (typeof value === "number" || typeof value === "boolean") result[key] = value;
    else if (typeof value === "string") result[key] = cleanText(value, key === "text" ? context.findingTextLimit : 600);
  }
  return result;
}

function compactFindings(value, context) {
  // Filter first, then cap: identity noise must not consume the report's quota.
  const entries = value.map((entry) => compactFinding(entry, context)).filter(Boolean);
  if (context.findingLimit === null || entries.length <= context.findingLimit) return entries;
  context.omittedEntries += entries.length - context.findingLimit;
  return entries.slice(0, context.findingLimit);
}

function sanitizeValue(value, key, context) {
  if (DROP_KEYS.test(key)) {
    // 保留状态码、计数和布尔结果，但绝不保留敏感字段中的字符串/对象。
    if (typeof value === "number" || typeof value === "boolean") return value;
    return undefined;
  }
  if (PATH_KEYS.test(key)) return undefined;
  if (OUTPUT_PATH_KEYS.test(key)) {
    if (value == null) return value;
    const path = String(value == null ? "" : value).replace(/[\\/]+$/, "");
    return path ? path.split(/[\\/]/).pop() : "";
  }
  if (/(?:url|uri|href)$/i.test(key) || key === "url") return sanitizeUrl(value);
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return cleanText(value);
  if (Array.isArray(value)) {
    const entries = key === "top"
      ? value.filter((entry) => !isDiagnosticNoise(entry, context.identities))
      : value;
    return entries.map((entry) => sanitizeValue(entry, key, context)).filter((entry) => entry !== undefined);
  }
  if (typeof value !== "object") return undefined;

  const result = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    if (DROP_COLLECTIONS.has(childKey) && Array.isArray(childValue)) {
      result[childKey] = { count: childValue.length };
      continue;
    }
    if (childKey === "target" && childValue && typeof childValue === "object") {
      result[childKey] = safeTarget(childValue);
      continue;
    }
    if ((childKey === "findings" || childKey === "hits") && Array.isArray(childValue)) {
      result[childKey] = compactFindings(childValue, context);
      continue;
    }
    const cleaned = sanitizeValue(childValue, childKey, context);
    if (cleaned !== undefined) result[childKey] = cleaned;
  }
  return result;
}

// 内层结果收缩成计数前，先保留已有的部分结果标记。
function hasPartialResult(value) {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasPartialResult);
  if (value.complete === false || value.truncated === true) return true;
  if (value.exhausted === true) return true;
  return ["targets", "snapshots", "shots", "log", "steps", "coverage", "budget", "timeBudget", "results"]
    .some((key) => hasPartialResult(value[key]));
}

function sanitizeDiagnosticReport(report, { findingLimit = 500, findingTextLimit = 600 } = {}) {
  if (findingLimit !== null && (!Number.isInteger(findingLimit) || findingLimit < 1)) {
    throw new TypeError("findingLimit 必须是正整数或 null。");
  }
  if (!Number.isInteger(findingTextLimit) || findingTextLimit < 1 || findingTextLimit > 1200) {
    throw new TypeError("findingTextLimit 必须是 1 到 1200 之间的整数。");
  }
  const context = { identities: collectIdentityHints(report), findingLimit, findingTextLimit, omittedEntries: 0 };
  const result = sanitizeValue(report, "", context) || {};
  if (Array.isArray(result.findings) && result.summary && typeof result.summary.findings === "number") {
    result.summary.findings = result.findings.length;
  }
  if (Array.isArray(result.hits) && Array.isArray(report && report.hits)) {
    // 只修正数组长度的镜像计数，其他统计仍由调用方负责。
    const rawLength = report.hits.length;
    if (typeof result.hitCount === "number" && result.hitCount === rawLength) {
      result.hitCount = result.hits.length;
    }
    if (result.summary && typeof result.summary.hitCount === "number" && result.summary.hitCount === rawLength) {
      result.summary.hitCount = result.hits.length;
    }
  }
  if (context.omittedEntries) {
    result.reportTruncation = {
      omittedEntries: (Number(result.reportTruncation && result.reportTruncation.omittedEntries) || 0) + context.omittedEntries
    };
  }
  if (context.omittedEntries || hasPartialResult(report)) result.complete = false;
  return result;
}

function assertOutputFile(filePath, expectedExtension, label) {
  const resolved = path.resolve(String(filePath || ""));
  const generated = path.resolve(DIAGNOSTIC_GENERATED_DIR);
  ensureGeneratedDir();
  const relative = path.relative(generated, resolved);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label}路径必须位于项目同级 _generated 目录内。 `);
  }
  if (path.dirname(resolved) !== generated) {
    throw new Error(`${label}只能直接写入项目同级 _generated，不能使用子目录。 `);
  }
  const filename = path.basename(resolved);
  if (path.extname(filename).toLowerCase() !== expectedExtension) {
    throw new Error(`${label}必须使用 ${expectedExtension} 文件名。 `);
  }
  validateOutputName(filename);
  try {
    const stat = fs.lstatSync(resolved);
    if (stat.isSymbolicLink()) {
      throw new Error(`${label}目标不能是符号链接。 `);
    }
    if (!stat.isFile()) {
      throw new Error(`${label}目标必须是普通文件。 `);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return resolved;
}

// 返回实际写盘的脱敏结果；调用方按它汇总，不使用过滤前的计数。
function writeDiagnosticReport(filePath, report, options) {
  const resolved = assertOutputFile(filePath, ".json", "诊断报告");
  const sanitized = sanitizeDiagnosticReport(report, options);
  // Only sanitized content reaches disk. Rename after a complete write so an
  // interrupted export leaves the previous report intact.
  const temporary = `${resolved}.${process.pid}-${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(sanitized, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
    fs.renameSync(temporary, resolved);
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return sanitized;
}

function normalizeScreenshotData(data) {
  if (Buffer.isBuffer(data)) return data;
  if (typeof data !== "string") {
    throw new TypeError("诊断截图数据必须是 Buffer 或 base64 字符串。 ");
  }
  const compact = data.replace(/\s+/g, "");
  const unpadded = compact.replace(/=+$/, "");
  if (
    !/^[A-Za-z0-9+/]*={0,2}$/.test(compact) ||
    unpadded.includes("=") ||
    unpadded.length % 4 === 1
  ) {
    throw new Error("诊断截图数据不是合法的 base64 字符串。 ");
  }
  const decoded = Buffer.from(compact, "base64");
  if (decoded.toString("base64").replace(/=+$/, "") !== unpadded) {
    throw new Error("诊断截图数据不是合法的 base64 字符串。 ");
  }
  return decoded;
}

function writeDiagnosticScreenshot(filePath, data) {
  const resolved = assertOutputFile(filePath, ".png", "诊断截图");
  fs.writeFileSync(resolved, normalizeScreenshotData(data));
}

module.exports = {
  DIAGNOSTIC_GENERATED_DIR,
  resolveDiagnosticOutputPath,
  sanitizeDiagnosticReport,
  writeDiagnosticReport,
  writeDiagnosticScreenshot
};
