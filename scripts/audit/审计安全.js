"use strict";

const fs = require("node:fs");
const path = require("node:path");

// All generated audit artifacts belong to the workspace sibling directory.
// Accepting a path from the command line would otherwise let a routine audit
// overwrite arbitrary files on the operator's machine.
const AUDIT_GENERATED_DIR = path.resolve(__dirname, "..", "..", "..", "_generated");
const OUTPUT_EXTENSIONS = new Set([".json", ".png"]);

function ensureAuditGeneratedDir() {
  fs.mkdirSync(AUDIT_GENERATED_DIR, { recursive: true });
  let stat;
  try {
    stat = fs.lstatSync(AUDIT_GENERATED_DIR);
  } catch (error) {
    throw new Error(`无法访问项目同级 _generated 目录：${error.message}`);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("项目同级 _generated 必须是普通目录，不能是符号链接或其他文件。 ");
  }
}

function validateAuditOutputName(value, fallback = "audit-report") {
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

function resolveAuditOutputBase(value, fallback = "audit-report") {
  const requested = validateAuditOutputName(value, fallback);
  const extension = path.extname(requested);
  const stem = extension ? requested.slice(0, -extension.length) : requested;
  if (!stem || stem === "." || stem === "..") {
    throw new Error("--out 文件名不能为空。 ");
  }
  ensureAuditGeneratedDir();
  return path.join(AUDIT_GENERATED_DIR, stem);
}

function resolveAuditOutputPath(value, fallback = "audit-report.json") {
  const requested = validateAuditOutputName(value, fallback);
  const extension = path.extname(requested).toLowerCase();
  // Reports are JSON. A .png --out value is accepted as a convenient base
  // name and normalized to the corresponding JSON report path.
  const filename = extension === ".png"
    ? `${requested.slice(0, -4)}.json`
    : extension
      ? requested
      : `${requested}.json`;
  ensureAuditGeneratedDir();
  return path.join(AUDIT_GENERATED_DIR, filename);
}

// 审计报告只能保留定位漏翻所需的短文本和计数。
// 页面 URL 可能含 userId/teamId，DOM 快照也可能混入请求正文、响应或输入值，
// 因此所有审计脚本在写 JSON 前都必须经过这里的裁剪。

// 这些字段可能直接携带请求/响应正文、输入值、认证信息或 CDP 内部对象。
// 数字和布尔值仍由 sanitizeValue 保留，避免丢掉状态码、计数等汇总信息。
const DROP_KEYS = /^(?:webSocketDebuggerUrl|websocket|browserPath|sampleText|bodyPreview|bodyText|body|rawBody|postData|postDataEntries|payload|requestPayload|responsePayload|requestBody|responseBody|inputValue|inputValues|formData|formEntries|targetPreview|combinedText|innerText|outerText|textContent|value|headers|requestHeaders|responseHeaders|cookies|authorization|proxyAuthorization|token|idToken|accessToken|refreshToken|secret|password|clientSecret|apiKey|queryParams|searchParams|stack|exceptionDetails|targetId|parentId|openerId|sessionId)$/i;
const DROP_COLLECTIONS = new Set(["log", "snapshots", "actions", "entries", "axEntries", "overlays", "targets", "targetPreview", "errors"]);
const PATH_KEYS = /^(?:path|filePath|portFile|sourcePath|directory|directoryPath|rootPath|cwd|workingDirectory|workspacePath|screenshotPath)$/i;
const OUTPUT_PATH_KEYS = /^(?:out|screenshot)$/i;
const KEEP_FINDING_KEYS = new Set([
  "text", "key", "kind", "attribute", "tag", "role", "count", "step", "phase", "surface", "surfaces", "phases", "tabs"
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

function isAuditNoiseFinding(item, identities = new Set()) {
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

function filterAuditFindings(value, contextValue = value) {
  if (!Array.isArray(value)) return [];
  const identities = contextValue instanceof Set ? contextValue : collectIdentityHints(contextValue);
  return value.filter((item) => !isAuditNoiseFinding(item, identities));
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
  if (!item || typeof item !== "object") return null;
  if (isAuditNoiseFinding(item, context.identities)) return null;
  const result = {};
  for (const key of KEEP_FINDING_KEYS) {
    if (!(key in item)) continue;
    const value = item[key];
    if (Array.isArray(value)) {
      result[key] = value.slice(0, 20).map((entry) => {
        if (entry && typeof entry === "object") {
          const compact = {};
          for (const field of ["tabId", "tabName", "name"]) {
            if (field in entry) compact[field] = cleanText(entry[field], 160);
          }
          return compact;
        }
        return cleanText(entry, 160);
      });
    }
    else if (typeof value === "number" || typeof value === "boolean") result[key] = value;
    else result[key] = cleanText(value, 600);
  }
  return result;
}

function compactCollection(value, key, context) {
  if (!Array.isArray(value)) return [];
  if (key === "actions") {
    return value.slice(0, 500).map((item) => {
      if (!item || typeof item !== "object") return { ok: false };
      const result = {};
      for (const field of ["name", "label", "type", "surface", "phase", "spec", "reason", "ok", "successful"]) {
        if (!(field in item)) continue;
        result[field] = typeof item[field] === "boolean" ? item[field] : cleanText(item[field], 160);
      }
      return result;
    });
  }
  if (key === "snapshots" || key === "log") {
    return value.slice(0, 500).map((item) => {
      if (!item || typeof item !== "object") return {};
      const result = {};
      for (const field of ["name", "step", "label", "phase", "tabId", "tabName", "hitCount", "targetCount", "overlayCount", "rootCount", "findings", "hits"]) {
        if (!(field in item)) continue;
        if (field === "findings" || field === "hits") {
          result[field] = Array.isArray(item[field]) ? item[field].slice(0, 100).map((entry) => compactFinding(entry, context)).filter(Boolean) : [];
        } else if (typeof item[field] === "number" || typeof item[field] === "boolean") {
          result[field] = item[field];
        } else {
          result[field] = cleanText(item[field], 160);
        }
      }
      return result;
    });
  }
  // entries/targets/overlays 只保留数量；其中可能含按钮正文或用户工作区名称。
  return { count: value.length };
}

function sanitizeValue(value, key = "", context = { identities: new Set() }) {
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
      ? value.filter((entry) => !isAuditNoiseFinding(entry, context.identities))
      : value;
    return entries.map((entry) => sanitizeValue(entry, key, context)).filter((entry) => entry !== undefined);
  }
  if (typeof value !== "object") return undefined;

  const result = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    if (DROP_COLLECTIONS.has(childKey) && Array.isArray(childValue)) {
      result[childKey] = compactCollection(childValue, childKey, context);
      continue;
    }
    if (childKey === "target" && childValue && typeof childValue === "object") {
      result[childKey] = safeTarget(childValue);
      continue;
    }
    if ((childKey === "findings" || childKey === "hits") && Array.isArray(childValue)) {
      result[childKey] = childValue.slice(0, 500).map((entry) => compactFinding(entry, context)).filter(Boolean);
      continue;
    }
    const cleaned = sanitizeValue(childValue, childKey, context);
    if (cleaned !== undefined) result[childKey] = cleaned;
  }
  return result;
}

function sanitizeAuditReport(report) {
  const context = { identities: collectIdentityHints(report) };
  const result = sanitizeValue(report, "", context) || {};
  if (Array.isArray(report && report.findings) && result.summary && typeof result.summary.findings === "number") {
    result.summary.findings = filterAuditFindings(report.findings, context.identities).length;
  }
  return result;
}

function assertAuditOutputFile(filePath, expectedExtension, label) {
  const resolved = path.resolve(String(filePath || ""));
  const generated = path.resolve(AUDIT_GENERATED_DIR);
  ensureAuditGeneratedDir();
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
  validateAuditOutputName(filename);
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

function writeAuditReport(filePath, report) {
  const resolved = assertAuditOutputFile(filePath, ".json", "审计报告");
  fs.writeFileSync(resolved, JSON.stringify(sanitizeAuditReport(report), null, 2) + "\n", "utf8");
}

function normalizeScreenshotData(data) {
  if (Buffer.isBuffer(data)) return data;
  if (typeof data !== "string") {
    throw new TypeError("审计截图数据必须是 Buffer 或 base64 字符串。 ");
  }
  const compact = data.replace(/\s+/g, "");
  const unpadded = compact.replace(/=+$/, "");
  if (
    !/^[A-Za-z0-9+/]*={0,2}$/.test(compact) ||
    unpadded.includes("=") ||
    unpadded.length % 4 === 1
  ) {
    throw new Error("审计截图数据不是合法的 base64 字符串。 ");
  }
  const decoded = Buffer.from(compact, "base64");
  if (decoded.toString("base64").replace(/=+$/, "") !== unpadded) {
    throw new Error("审计截图数据不是合法的 base64 字符串。 ");
  }
  return decoded;
}

function writeAuditScreenshot(filePath, data) {
  const resolved = assertAuditOutputFile(filePath, ".png", "审计截图");
  fs.writeFileSync(resolved, normalizeScreenshotData(data));
}

function selfTest() {
  const sanitized = sanitizeAuditReport({
    target: { title: "Postman C:\\Users\\Example\\private-request", url: "https://desktop.postman.com/?userId=123&token=secret" },
    source: { port: 12345, portFile: "C:\\Users\\Example\\Postman\\DevToolsActivePort", path: "/home/example/private" },
    out: "C:\\Users\\Example\\_generated\\report.json",
    screenshot: null,
    webSocketDebuggerUrl: "ws://127.0.0.1:12345/devtools/browser/secret",
    request: {
      status: 200,
      url: "https://api.example.test/items?userId=123#private",
      headers: { Authorization: "Bearer header-secret" },
      postData: "raw request body",
      response: { status: 201, body: "raw response body" }
    },
    postData: "raw body",
    payload: { text: "payload secret" },
    body: "body secret",
    inputValue: "typed secret",
    authorization: "Bearer top-level-secret",
    token: "top-level-token",
    error: "读取 \"C:\\Users\\Example\\secret.txt\"；UNC \\\\server\\share\\secret.txt；Unix /home/example/private.txt；Authorization: Bearer error-secret；ws://127.0.0.1:12345/devtools/browser/secret；https://api.example.test/?token=url-secret",
    requestBody: "secret body",
    summary: { snapshots: 3, actions: 2, findings: 1 },
    actions: [{ name: "open", ok: true, target: { inputValue: "secret" } }],
    findings: [
      { text: "Open https://example.test/path?token=finding-secret", count: 1 },
      { text: '{"requestBody":"this is a long private body that must not be written to the audit report","name":"secret"}', count: 1 }
    ]
  });
  const serialized = JSON.stringify(sanitized);
  const filtered = sanitizeAuditReport({
    summary: { findings: 26 },
    snapshots: [{
      name: "identity-context",
      hits: [
        { text: "example-user 的头像", kind: "attribute", attribute: "aria-label" },
        { text: "demo-team-181381 团队标志", kind: "attribute", attribute: "alt" }
      ]
    }],
    findings: [
      { text: "button", kind: "ax-role" },
      { text: "menuitem", kind: "text" },
      { text: "aether-button-tooltip", kind: "attribute", attribute: "data-aether-id" },
      { text: "request-editor-tab--body", kind: "attribute", attribute: "data-testid" },
      { text: "env-filter-select-trigger-prod", kind: "text" },
      { text: "WORKSPACE-README.md", kind: "text" },
      { text: "邀请 .trial_button { background: #fff; color: black; } 企业试用", kind: "text" },
      { text: "example-user", kind: "text" },
      { text: "demo-team-181381", kind: "text" },
      { text: "example-user 的头像", kind: "attribute", attribute: "aria-label" },
      { text: "demo-team-181381 团队标志", kind: "attribute", attribute: "alt" },
      { text: "example-user，你今天想如何使用 Postman？", kind: "text" },
      { text: "使用现有 Playwright 测试验证 API 行为", kind: "text" },
      { text: "返回（Alt+左方向键）", kind: "attribute", attribute: "aria-label" },
      { text: "GET 未命名请求", kind: "text" },
      { text: "example-user demo@example.test", kind: "text" },
      { text: "example-user （你）", kind: "text" },
      { text: "Open request", kind: "text" },
      { text: "Can access", kind: "text" },
      { text: "Create a button", kind: "text" },
      { text: "Open WORKSPACE-README.md", kind: "text" },
      { text: "Edit CSS styles", kind: "text" },
      { text: "Manage example-user workspace", kind: "text" },
      { text: "Request editor", kind: "text" },
      { text: "Environment filter", kind: "text" },
      { text: "Aether integration", kind: "text" }
    ]
  });
  const filteredTexts = filtered.findings.map((item) => item.text);
  const greetingFiltered = sanitizeAuditReport({
    summary: { findings: 3 },
    findings: [
      { text: "sample-user，你今天想如何使用 Postman？", kind: "text" },
      { text: "sample-user", kind: "text" },
      { text: "No environment", kind: "text" }
    ]
  });
  const checks = [
    [sanitized.summary.snapshots, 3],
    [sanitized.summary.actions, 2],
    [sanitized.summary.findings, 2],
    [sanitized.target.title, "Postman [本机路径已隐藏]"],
    [sanitized.target.url, "https://desktop.postman.com/"],
    [sanitized.out, "report.json"],
    [sanitized.screenshot, null],
    [sanitized.source.port, 12345],
    [sanitized.request.status, 200],
    [sanitized.request.response.status, 201],
    [sanitized.findings[0].text, "Open https://example.test/path"],
    [sanitized.findings.length, 2],
    [sanitized.findings[1].text, "[疑似请求/响应正文已隐藏]"],
    [sanitizeUrl("wss://127.0.0.1:12345/devtools/browser/secret"), "[WebSocket 地址已隐藏]"],
    [sanitizeUrl("https://example.test/path?token=secret#fragment"), "https://example.test/path"],
    [sanitized.source.portFile, undefined],
    [sanitized.request.headers, undefined],
    [sanitized.request.postData, undefined],
    [sanitized.request.response.body, undefined],
    [sanitized.postData, undefined],
    [sanitized.payload, undefined],
    [sanitized.body, undefined],
    [sanitized.inputValue, undefined],
    [sanitized.authorization, undefined],
    [sanitized.token, undefined],
    [/C:\\\\Users|\\\\\\\\server\\share|\/home\/example|userId=|token=|ws:\/\/|Bearer\s+(?:header|top-level|error)-secret|raw (?:request|response)? body|secret\.txt/i.test(serialized), false],
    [filtered.summary.findings, 9],
    [filtered.findings.length, 9],
    [filtered.snapshots[0].hits.length, 0],
    [filteredTexts.includes("button"), false],
    [filteredTexts.includes("menuitem"), false],
    [filteredTexts.includes("aether-button-tooltip"), false],
    [filteredTexts.includes("request-editor-tab--body"), false],
    [filteredTexts.includes("env-filter-select-trigger-prod"), false],
    [filteredTexts.includes("WORKSPACE-README.md"), false],
    [filteredTexts.some((text) => text.includes("background: #fff")), false],
    [filteredTexts.includes("example-user"), false],
    [filteredTexts.includes("demo-team-181381"), false],
    [filteredTexts.includes("Open request"), true],
    [filteredTexts.includes("Can access"), true],
    [filteredTexts.includes("Create a button"), true],
    [filteredTexts.includes("Open WORKSPACE-README.md"), true],
    [filteredTexts.includes("Edit CSS styles"), true],
    [filteredTexts.includes("Manage example-user workspace"), true],
    [filteredTexts.includes("Request editor"), true],
    [filteredTexts.includes("Environment filter"), true],
    [filteredTexts.includes("Aether integration"), true],
    [isAuditNoiseFinding({ text: "Link", kind: "text" }), false],
    [isAuditNoiseFinding({ text: "Image", kind: "text" }), false],
    [isAuditNoiseFinding({ text: "link", kind: "ax-role" }), true],
    [isAuditNoiseFinding({ text: "image", kind: "attribute", attribute: "role" }), true],
    [greetingFiltered.summary.findings, 1],
    [greetingFiltered.findings.length, 1],
    [greetingFiltered.findings[0].text, "No environment"]
  ];
  const generated = AUDIT_GENERATED_DIR;
  const outputPathChecks = [
    [resolveAuditOutputPath("自检报告"), path.join(generated, "自检报告.json")],
    [resolveAuditOutputPath("自检报告.png"), path.join(generated, "自检报告.json")],
    [resolveAuditOutputBase("自检报告.json"), path.join(generated, "自检报告")]
  ];
  for (const [actual, expected] of outputPathChecks) checks.push([actual, expected]);
  for (const invalid of ["../逃逸.json", "..\\逃逸.json", "C:\\逃逸.json", "/tmp/逃逸.json", "目录/报告.json", "报告.txt", "报告:数据流.json"]) {
    let rejected = false;
    try { resolveAuditOutputPath(invalid); } catch (_) { rejected = true; }
    checks.push([rejected, true]);
  }
  let escapedWriteRejected = false;
  try { writeAuditReport(path.join(generated, "..", "逃逸.json"), {}); } catch (_) { escapedWriteRejected = true; }
  checks.push([escapedWriteRejected, true]);
  let nestedWriteRejected = false;
  try { writeAuditReport(path.join(generated, "子目录", "嵌套.json"), {}); } catch (_) { nestedWriteRejected = true; }
  checks.push([nestedWriteRejected, true]);
  checks.push([assertAuditOutputFile(path.join(generated, "自检截图.png"), ".png", "审计截图"), path.join(generated, "自检截图.png")]);
  checks.push([normalizeScreenshotData(Buffer.from([0x89, 0x50, 0x4e, 0x47])).toString("hex"), "89504e47"]);
  checks.push([normalizeScreenshotData("iVBORw==").toString("hex"), "89504e47"]);
  for (const [invalidPath, data] of [
    [path.join(generated, "..", "逃逸.png"), "iVBORw=="],
    [path.join(generated, "子目录", "嵌套.png"), "iVBORw=="],
    [path.join(generated, "自检截图.png:数据流"), "iVBORw=="],
    [path.join(generated, "自检截图.json"), "iVBORw=="],
    [path.join(generated, "自检截图.png"), { data: "iVBORw==" }],
    [path.join(generated, "自检截图.png"), "不是 base64"]
  ]) {
    let rejected = false;
    try { writeAuditScreenshot(invalidPath, data); } catch (_) { rejected = true; }
    checks.push([rejected, true]);
  }
  const failed = checks.filter(([actual, expected]) => actual !== expected);
  if (failed.length) throw new Error(`自检失败，共 ${failed.length} 项不符合预期。`);
  console.log(`审计报告脱敏自检通过，共 ${checks.length} 项。`);
}

if (require.main === module) selfTest();

module.exports = {
  AUDIT_GENERATED_DIR,
  sanitizeAuditReport,
  filterAuditFindings,
  isAuditNoiseFinding,
  sanitizeUrl,
  safeTarget,
  validateAuditOutputName,
  resolveAuditOutputBase,
  resolveAuditOutputPath,
  writeAuditReport,
  writeAuditScreenshot
};
