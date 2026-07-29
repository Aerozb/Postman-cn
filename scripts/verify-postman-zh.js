#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

function argValue(name) {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) {
    return process.argv[index + 1];
  }
  return null;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeForConsole(value) {
  return JSON.stringify(value, (_key, current) => {
    if (typeof current !== "string") {
      return current;
    }
    return current.replace(/[\u007f-\uffff]/g, (ch) => {
      return "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0");
    });
  }, 2);
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${url}`);
  }
  return response.json();
}

function resolvePortFile() {
  const appData = process.env.APPDATA;
  if (!appData) {
    throw new Error("APPDATA is not set; cannot locate Postman DevToolsActivePort.");
  }
  return path.join(appData, "Postman", "DevToolsActivePort");
}

function inspectUpdatePatch(postmanDir) {
  if (!postmanDir) {
    return { checked: false, disabled: false, reason: "postman dir not provided" };
  }
  const mainJs = path.join(postmanDir, "resources", "app.asar.unpacked.zh", "main.js");
  if (!fs.existsSync(mainJs)) {
    return { checked: false, disabled: false, reason: "patched main.js not found" };
  }
  const content = fs.readFileSync(mainJs, "utf8");
  // isUpdateEnabled is intentionally left untouched now; blocking
  // downloadUpdate/restartAppToUpdate is what actually prevents updates
  // while keeping the Settings > Update page functional.
  const runtimeGuard = content.includes("postman-zh:update-guard") &&
    content.includes("__postmanZhUpdatesDisabled") &&
    content.includes('p("checkForUpdates"') &&
    content.includes('p("quitAndInstall"');
  const sourceOptimizations = {
    download: content.includes("updates disabled by postman-zh"),
    restart: content.includes("update restart blocked by postman-zh")
  };
  return { checked: true, disabled: runtimeGuard, runtimeGuard, sourceOptimizations };
}

function inspectExternalUrlPatch(postmanDir) {
  if (!postmanDir) {
    return { checked: false, installed: false, reason: "postman dir not provided" };
  }
  const mainJs = path.join(postmanDir, "resources", "app.asar.unpacked.zh", "main.js");
  if (!fs.existsSync(mainJs)) {
    return { checked: false, installed: false, reason: "patched main.js not found" };
  }
  const content = fs.readFileSync(mainJs, "utf8");
  const installed = content.includes("postmanZhPatchOpenExternalQuotes") &&
    content.includes("__postmanZhOpenExternalPatched") &&
    content.includes("openExternal=function");
  return { checked: true, installed };
}

function inspectMainMenuPatch(postmanDir) {
  if (!postmanDir) {
    return { checked: false, installed: false, missing: ["postman dir not provided"] };
  }
  const mainJs = path.join(postmanDir, "resources", "app.asar.unpacked.zh", "main.js");
  if (!fs.existsSync(mainJs)) {
    return { checked: false, installed: false, missing: ["patched main.js not found"] };
  }
  const content = fs.readFileSync(mainJs, "utf8");
  const required = [
    "postmanZhLocalizeMenuTemplate",
    "Show DevTools (Current View)",
    "\\u663e\\u793a\\u5f00\\u53d1\\u8005\\u5de5\\u5177\\uff08\\u5f53\\u524d\\u89c6\\u56fe\\uff09",
    "View Logs in Explorer",
    "\\u5728\\u8d44\\u6e90\\u7ba1\\u7406\\u5668\\u4e2d\\u67e5\\u770b\\u65e5\\u5fd7"
  ];
  const missing = required.filter((needle) => !content.includes(needle));
  return { checked: true, installed: missing.length === 0, missing };
}

async function connectCdp(wsUrl) {
  let nextId = 1;
  const pending = new Map();
  const ws = new WebSocket(wsUrl);

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out connecting to CDP websocket.")), 10000);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("Failed to connect to CDP websocket."));
    }, { once: true });
  });

  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) {
      return;
    }
    const callbacks = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) {
      callbacks.reject(new Error(message.error.message || JSON.stringify(message.error)));
    } else {
      callbacks.resolve(message.result);
    }
  });

  return {
    send(method, params = {}) {
      const id = nextId++;
      ws.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            reject(new Error(`CDP command timed out: ${method}`));
          }
        }, 15000);
      });
    },
    close() {
      try {
        ws.close();
      } catch (_) {}
    }
  };
}

async function waitForPostmanTarget(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastTargets = [];
  while (Date.now() < deadline) {
    try {
      const targets = await getJson(`http://127.0.0.1:${port}/json/list`);
      lastTargets = targets;
      const pageTargets = targets.filter((item) => {
        return item.type === "page" &&
          item.webSocketDebuggerUrl &&
          !String(item.url || "").startsWith("devtools://");
      });
      const target = pageTargets.find((item) => {
        return /^https:\/\/desktop\.postman\.com\b/i.test(String(item.url || ""));
      }) || pageTargets.find((item) => {
        return !/^https:\/\/www\.postman\.com\/complete-checkout\b/i.test(String(item.url || ""));
      });
      if (target) {
        return target;
      }
    } catch (_) {}
    await sleep(1000);
  }
  throw new Error(`Cannot find a Postman page target. Targets: ${JSON.stringify(lastTargets)}`);
}

async function main() {
  const timeoutMs = Number(argValue("--timeout-ms") || 30000);
  const postmanDir = argValue("--postman-dir");
  const expectUpdatesDisabled = hasFlag("--expect-updates-disabled");
  const portFile = resolvePortFile();

  if (!fs.existsSync(portFile)) {
    throw new Error(
      "DevToolsActivePort not found. Start Postman with --remote-debugging-port=0 first."
    );
  }

  const port = fs.readFileSync(portFile, "utf8").split(/\r?\n/)[0].trim();
  if (!/^\d+$/.test(port)) {
    throw new Error(`Invalid DevTools port: ${port}`);
  }

  const target = await waitForPostmanTarget(port, timeoutMs);
  const cdp = await connectCdp(target.webSocketDebuggerUrl);
  try {
    await cdp.send("Runtime.enable");
    await sleep(1500);

    const expression = `(() => {
      const knownEnglish = [
        "Duplicate Tab",
        "Force Close All Tabs",
        "Reveal in Sidebar",
        "New Environment",
        "New Request",
        "Untitled Request",
        "Clone",
        "Copy flow link",
        "View analytics",
        "Confirm force close",
        "Force Close",
        "Establish a connection to send and receive messages.",
        "Type to filter",
        "Send request to get a response",
        "Agent Mode is not available for your account. Contact your team admin for more.",
        "You can enable Agent Mode for your team. Access can be revoked in the product access page.",
        "Add documentation to help others get started…",
        "Want to learn more about Enterprise Trial?",
        "Your Enterprise Trial ends in 28 days",
        "Take the next step to continue without interruption",
        "Your team grew to 1 teammates",
        "Keep your team working together",
        "Contact us",
        "You can take this action when you're back online.",
        "You do not have permission to add items",
        "You cannot create a flow when you’re offline.",
        "You cannot create an environment when you’re offline.",
        "You need to be online to create a webhook.",
        "You cannot create a collection when you’re offline.",
        "You cannot create a monitor when you're offline.",
        "You cannot create an insights project when you're offline.",
        "You cannot generate an SDK when you're offline.",
        "People in the workspace",
        "Start live session",
        "Unknown Item",
        "RECENTLY VIEWED",
        "Add workspaces to the Private API Network",
        "Make workspaces easily discoverable for your team by adding them to the network.",
        "Welcome to the Private API Network",
        "This is a central directory of all workspaces in your organization. Your teams can discover available workspaces and use tags to organize and find them easily.",
        "Request workspaces from where you build",
        "Add workspaces directly from where you create and manage them.",
        "Get quick approvals from designated managers",
        "Add comments and let Team Managers and Network Managers help review and curate workspaces with intent.",
        "Added workspaces",
        "Review",
        "Last 100 runs",
        "Run by",
        "Run status",
        "Source",
        "Start time",
        "Duration",
        "All tests",
        "Passed",
        "Skipped",
        "Avg. Resp. Time",
        "Your collection has not been run yet",
        "Runs triggered for this collection via",
        "and Postman CLI.",
        "No performance runs for this collection",
        "No scheduled runs for this collection",
        "No 计划运行 for this collection",
        "Choose how to run your performance test",
        "In the app",
        "Via the CLI",
        "Deselect All",
        "20 VUs",
        "10 mins",
        "Field cannot be empty",
        "Response Time",
        "Average",
        "Others",
        "Error %",
        "Requests per second",
        "is less than",
        "is greater than",
        "is less than equal to",
        "is greater than equal to",
        "Request Timeout",
        "Timeout for requests in milliseconds. Setting this to 0 will disable the timeout.",
        "Timeout for 请求s in milliseconds. Setting this to 0 will disable the timeout.",
        "Save request to share",
        "Save 请求 to share",
        "Before sharing this request, you need to save it to a collection.",
        "Before sharing this 请求, you need to save it to a collection.",
        "Save and Share",
        "Verify server certificate when connecting over a secure connection.",
        "Client version",
        "Choose client version that should be used for connecting with the server.",
        "Client version that will be used for connecting with the server.",
        "Handshake path",
        "Set the server path that should be used during the handshake request.",
        "Set the server path that should be used during the handshake 请求.",
        "Server path that will be used during the handshake request.",
        "Server path that will be used during the 握手请求.",
        "Handshake request timeout",
        "Handshake 请求 timeout",
        "Set how long the handshake request should wait before timing out in milliseconds. To never time out, set to 0.",
        "Set how long the handshake 请求 should wait before timing out in milliseconds. To never time out, set to 0.",
        "Reconnection attempts",
        "Maximum reconnection attempts when the connection closes abruptly.",
        "Reconnection intervals",
        "Interval between each reconnection attempt in milliseconds.",
        "No variables used yet. Learn more about variables.",
        "No variables used yet. 了解更多： variables.",
        "Prepend // to any row you want to add but keep disabled",
        "前置 // to any row you want to add but 保持禁用",
        "Share collection",
        "More Actions",
        "Enter name, group name or email...",
        "can view collection via link",
        "Include environment",
        "Collaborate with your teammates in real time.",
        "With Postman's Enterprise Trial,",
        "you can share with unlimited teammates",
        "Select from computer",
        "Files uploaded to this workspace",
        "No files uploaded yet. Upload files to this workspace to share and reuse test data.",
        "Loading runs",
        "Periodic runs scheduled on the Postman Cloud.",
        "Upcoming run",
        "Simulate real-world traffic from your local machine and observe the performance of your APIs.",
        "You can schedule runs for this collection to periodically run it at a certain time or frequency on the Postman Cloud.",
        "Performance test runs for this collection.",
        "性能 test runs for this collection.",
        "Result",
        "Total requests",
        "Requests/s",
        "Resp. time (Avg ms)",
        "createdBy",
        "Run options",
        "Run performance Test",
        "Run 性能 Test",
        "Share all",
        "Reset all",
        "Show as column",
        "Shared Value",
        "Completed",
        "Aborted",
        "SDKS",
        "SDKs",
        "Create Fork",
        "创建 Fork",
        "This authorization method will be used for every request in this collection. You can override this by specifying one in the request.",
        "This collection does not use any authorization.",
        "This collection 不使用任何授权.",
        "Use JavaScript to write tests, visualize responses, and more.",
        "You need to be online to access all features in this workspace.",
        "scheduled-collection-runs-table-Table Body",
        "performance-runs-runs-table-Table Body",
        "No variables defined in this collection.",
        "This variable is overwritten by a duplicated key",
        "Share value with teammates and use it with monitors and scheduled runs.",
        "Share value with teammates and use it with monitors and 计划运行.",
        "Search Variables",
        "Write description",
        "Use JavaScript to configure requests dynamically.",
        "设置 vault",
        "There are no forks",
        "All forks created from this collection will appear here. Learn more:",
        "Source collection",
        "Forking creates a copy of the collection and enables you to perform changes without affecting the original. Learn more:",
        "Fork label",
        "Specify a label to distinguish this fork from the original collection.",
        "The fork will be created in the selected workspace.",
        "Environment to fork",
        "环境 to fork",
        "Selected environments will be forked and pinned for this collection.",
        "Select environments",
        "选择环境s",
        "Auto-pull changes",
        "Auto-pull changes from source collection",
        "Watch source collection to get notified of updates",
        "Watch forked collection to get notified of updates",
        "You'll be notified about changes made to the original collection.",
        "press Space or Enter to open",
        "Fork Collection",
        "No watchers",
        "People who watch this collection will show up here.",
        "Pull requests",
        "There are no pull requests",
        "Once a pull request is created for this collection, you will be able to manage it from here. Learn more:",
        "Ask questions or provide feedback. Use @mention to notify people.",
        "Filter comments",
        "Reload Changelog",
        "Collapse changelog for June 1, 2026",
        "Nested changelog entries",
        "查看 user information (1 user)",
        "1 change made:",
        "2 changes made:",
        "Branded, customizable developer docs",
        "Write guides in markdown (docs-as-code)",
        "Consumable by AI agents",
        "Fern is a Postman company.",
        "Generate SDK",
        "No collections or specifications found. Create a collection or specification to get started with SDK generation.",
        "Active webhook",
        "New Webhook",
        "Receive a Mock Event",
        "Webhook details",
        "Every hour",
        "Integrations will be created after you save monitor",
        "More templates",
        "Speed up your work with collection templates",
        "Postman has encountered an error. Learn more",
        "Enter vault key",
        "Set active",
        "Sign up to save your work remotely",
        "You are currently using the lightweight API Client. Sign in or create an account to save and back up your work into a workspace.",
        "to unlock this feature",
        "Workspaces help you stay organized and collaborate with your teammates.",
        "Recently Closed Tabs",
        "Duplicate Selected Tab",
        "Close Selected Tab",
        "Close All but Selected Tab"
      ];
      const translationProbeTargets = [
        "Stay on top of your APIs",
        "Upgrade to enterprise for detailed reports on team productivity, API behavior, and performance.",
        "Upgrade to Enterprise",
        "Learn more about reporting",
        "No workspaces",
        "MQTT Request",
        "Collapse section",
        "Connect",
        "Connect to send and receive messages",
        "Establish a connection to send and receive messages.",
        "Type to filter",
        "Send request to get a response",
        "Agent Mode is not available for your account. Contact your team admin for more.",
        "智能代理模式 is not available for your account. Contact your team admin for more.",
        "You can enable Agent Mode for your team. Access can be revoked in the product access page.",
        "You can enable 智能代理模式 for your team. Access can be revoked in the product access page.",
        "Add documentation to help others get started…",
        "添加 documentation to help others get started…",
        "View guide",
        "查看 guide",
        "Want to learn more about Enterprise Trial?",
        "Your Enterprise Trial ends in 28 days",
        "Take the next step to continue without interruption",
        "Your team grew to 1 teammates",
        "Keep your team working together",
        "Contact us",
        "You’re using features that require a paid plan to continue",
        "Keep shared workspaces, collaboration, and access for your 1 teammates",
        "Team Members are part of speeding-water-181381 team",
        "Generate SDK",
        "Generate SDKs",
        "SDKS",
        "SDKs",
        "Create Fork",
        "创建 Fork",
        "This authorization method will be used for every request in this collection. You can override this by specifying one in the request.",
        "This collection does not use any authorization.",
        "This collection 不使用任何授权.",
        "Use JavaScript to write tests, visualize responses, and more.",
        "No performance runs for this collection",
        "No scheduled runs for this collection",
        "No 计划运行 for this collection",
        "Choose how to run your performance test",
        "In the app",
        "Via the CLI",
        "Deselect All",
        "20 VUs",
        "10 mins",
        "Share collection",
        "More Actions",
        "Enter name, group name or email...",
        "can view collection via link",
        "Include environment",
        "Collaborate with your teammates in real time.",
        "With Postman's Enterprise Trial,",
        "you can share with unlimited teammates",
        "Select from computer",
        "Files uploaded to this workspace",
        "No files uploaded yet. Upload files to this workspace to share and reuse test data.",
        "Loading runs",
        "Periodic runs scheduled on the Postman Cloud.",
        "Upcoming run",
        "Simulate real-world traffic from your local machine and observe the performance of your APIs.",
        "You can schedule runs for this collection to periodically run it at a certain time or frequency on the Postman Cloud.",
        "Performance test runs for this collection.",
        "性能 test runs for this collection.",
        "Result",
        "Total requests",
        "Requests/s",
        "Resp. time (Avg ms)",
        "createdBy",
        "Run options",
        "Run performance Test",
        "Run 性能 Test",
        "Share all",
        "Reset all",
        "Show as column",
        "Shared Value",
        "Completed",
        "Aborted",
        "You need to be online to access all features in this workspace.",
        "scheduled-collection-runs-table-Table Body",
        "performance-runs-runs-table-Table Body",
        "No variables defined in this collection.",
        "This variable is overwritten by a duplicated key",
        "Share value with teammates and use it with monitors and scheduled runs.",
        "Share value with teammates and use it with monitors and 计划运行.",
        "Search Variables",
        "Write description",
        "Use JavaScript to configure requests dynamically.",
        "设置 vault",
        "There are no forks",
        "All forks created from this collection will appear here. Learn more:",
        "Source collection",
        "Forking creates a copy of the collection and enables you to perform changes without affecting the original. Learn more:",
        "Fork label",
        "Specify a label to distinguish this fork from the original collection.",
        "The fork will be created in the selected workspace.",
        "Environment to fork",
        "环境 to fork",
        "Selected environments will be forked and pinned for this collection.",
        "Select environments",
        "选择环境s",
        "Auto-pull changes",
        "Auto-pull changes from source collection",
        "Watch source collection to get notified of updates",
        "Watch forked collection to get notified of updates",
        "You'll be notified about changes made to the original collection.",
        "press Space or Enter to open",
        "Fork Collection",
        "No watchers",
        "People who watch this collection will show up here.",
        "Pull requests",
        "There are no pull requests",
        "Once a pull request is created for this collection, you will be able to manage it from here. Learn more:",
        "Ask questions or provide feedback. Use @mention to notify people.",
        "Filter comments",
        "Reload Changelog",
        "Collapse changelog for June 1, 2026",
        "Nested changelog entries",
        "查看 user information (1 user)",
        "1 change made:",
        "2 changes made:",
        "Branded, customizable developer docs",
        "Write guides in markdown (docs-as-code)",
        "Consumable by AI agents",
        "Fern is a Postman company.",
        "No collections or specifications found. Create a collection or specification to get started with SDK generation.",
        "Active webhook",
        "New Webhook",
        "Receive a Mock Event",
        "Webhook details",
        "Webhook events preview",
        "Every hour",
        "Hour timer",
        "Integrations will be created after you save monitor",
        "Notify a Slack or Microsoft Teams channel or chat",
        "More templates",
        "Speed up your work with collection templates",
        "Postman has encountered an error. Learn more",
        "Postman has encountered an error. 了解更多",
        "Private Network (0)",
        "Filter variables",
        "variable type",
        "variable values",
        "Share environment",
        "Set active",
        "Autosave changes to your requests and collections.",
        "Audit logs",
        "Postman keys",
        "Public elements",
        "Enter vault key",
        "Enter your vault key",
        "Reset vault",
        "Open Vault",
        "Set up HashiCorp integration",
        "Create Collection",
        "Create Specification",
        "Add description…",
        "Add new variable",
        "Created on",
        "Couldn't find the key?",
        "Looking to configure HashiCorp Vault for your team?",
        "Save this key to native password manager",
        "Store sensitive data in variable type secret to keep its values masked on the screen. Learn more:",
        "Work with the current value of a variable to prevent sharing sensitive values with your team. Learn more:",
        "Upgrade to the Team plan to share requests",
        "Upgrade to the Solo plan to access more features",
        "Upgrade to the Team plan to access more features",
        "Upgrade to the Enterprise plan to access more features",
        "Continue with Team Plan",
        "Continue with Solo Plan",
        "Continue with Enterprise Plan",
        "Advanced RBAC & organization controls",
        "Governance, audit logs & reporting",
        "Start Trial",
        "API monitoring",
        "Unlimited Collection Runner & Performance Testing runs",
        "Use mqtts:// to connect over TLS",
        "Hypertext Transfer Protocol (HTTP) is an application-layer protocol often used to build REST APIs. Test your HTTP API with an HTTP request.",
        "GraphQL is a query language for APIs that’s designed to provide the client with exactly the information it asks for. Test your GraphQL APIs with a GraphQL request.",
        "Test and customize Large Language Model (LLM) behaviors with custom instructions.",
        "The Model Context Protocol (MCP) is an open standard that enables developers to build secure, two-way connections between their data sources and AI-powered tools.",
        "gRPC is a highly performant RPC framework often used to build microservices. Test your gRPC APIs with a gRPC request.",
        "WebSocket enables real-time communication between the client and the server using a persistent communication channel. Test WebSocket based APIs with a WebSocket request.",
        "Socket.IO is a framework built on top of WebSocket to enable event driven client-server communication. Test Socket.IO based APIs with a Socket.IO request.",
        "MQTT is a lightweight messaging protocol widely used for the internet of things (IoT). Test MQTT based APIs with an MQTT request.",
        "Create a collection to organize, document and share your API requests with others.",
        "You are currently using the lightweight API Client. Sign in or create an account to organize your requests into collections and workspaces.",
        "Sign up to save your work remotely",
        "You are currently using the lightweight API Client. Sign in or create an account to save and back up your work into a workspace.",
        "Sign up to unlock this feature.",
        "注册 to unlock this feature.",
        "Workspaces help you stay organized and collaborate with your teammates.",
        "Recently Closed Tabs",
        "Duplicate Selected Tab",
        "Close Selected Tab",
        "Force Close Selected Tab",
        "强制关闭 Selected Tab",
        "Force 关闭选中的标签页",
        "Close All but Selected Tab",
        "Sign up to organize your work",
        "Search anything on the Public API Network",
        "搜索 anything on the Public API Network",
        "Search for anything on the Public API Network",
        "搜索 for anything on the Public API Network",
        "Search APIs on the Public API Network",
        "搜索 APIs on the Public API Network",
        "Search for APIs on the Public API Network",
        "搜索 for APIs on the Public API Network",
        "Search collections on the Public API Network",
        "搜索 collections on the Public API Network",
        "Search for collections on the Public API Network",
        "搜索 for collections on the Public API Network",
        "Search workspaces on the Public API Network",
        "搜索 workspaces on the Public API Network",
        "Search for workspaces on the Public API Network",
        "搜索 for workspaces on the Public API Network",
        "Search teams on the Public API Network",
        "搜索 teams on the Public API Network",
        "Search for teams on the Public API Network",
        "搜索 for teams on the Public API Network",
        "搜索 work pace  on the Public API Network",
        "Current",
        "Publisher",
        "Teams",
        "illustration-signIn",
        "You can take this action when you're back online.",
        "You can take this action when you’re back online.",
        "You do not have permission to add items",
        "You cannot create a flow when you’re offline.",
        "You cannot create an environment when you’re offline.",
        "You need to be online to create a webhook.",
        "You cannot create a collection when you’re offline.",
        "You cannot create a monitor when you're offline.",
        "You cannot create an insights project when you're offline.",
        "You cannot generate an SDK when you're offline.",
        "SETTINGS",
        "Request timeout in ms",
        "Max response size in MB",
        "Language detection",
        "Always open requests in new tab",
        "Allow reading files outside working directory",
        "Collaborate on files used in requests by sharing your working directory.",
        "Collaborate on files used in 请求s by sharing your working directory. 了解如何",
        "Expand connection configuration",
        "Personalize your Postman experience with a theme of your choice.",
        "System Default",
        "Manual",
        "Resize Request or Response Pane",
        "Alt + scroll",
        "Ctrl + 1 through Ctrl + 8",
        "through",
        "Rename Item",
        "重命名 Item",
        "Copy Item",
        "复制 Item",
        "Submit Modal",
        "Search Console",
        "Download Newman from npm",
        "CA Certificates",
        "Client Certificates",
        "Default Proxy Configuration",
        "Specify a proxy setting to act as an intermediary for requests sent through the Builder in Postman. These configurations do not apply to any Postman services.",
        "Use the system proxy",
        "Add a custom proxy configuration",
        "Automatically download major updates",
        "Checking for updates...",
        "Postman automatically downloads minor updates and bug fixes.",
        "Postman uses the system's proxy configurations by default to connect to any online services, or to send API requests.",
        "Respect HTTP_PROXY, HTTPS_PROXY, and NO_PROXY environment variables.",
        "You're on Postman v12.12.3",
        "Privacy",
        "Define and use sets of variables across multiple API requests using environments.",
        "Schedule your Postman collections to run periodically using monitors.",
        "Create a webhook to receive and inspect requests.",
        "Get near real-time insights into your API performance.",
        "Flows let you visualize, test, and automate API workflows",
        "GraphQL Request",
        "AI Request",
        "MCP Request",
        "gRPC Request",
        "WebSocket request",
        "Explore data available from server",
        "Select a provider or enter URL",
        "Enter command or paste JSON config",
        "Compose message",
        "Expand messages pane",
        "Listen",
        "Add event",
        "添加 event",
        "Create Mock Server",
        "Mock server name",
        "Create Monitor",
        "Monitor name",
        "Unable to load webhooks",
        "Insights: Observability for your APIs and AI",
        "Welcome to Insights",
        "Clone",
        "Copy flow link",
        "View analytics",
        "复制 flow link",
        "查看 analytics ↗",
        "Confirm force close",
        "Force Close",
        "1 tab has unsaved changes. Your changes will be lost if you force close this tab. Are you sure you want to force close?",
        "1 tab has unsaved changes. Your changes will be lost if you force close this tab. 确定吗 you want to force close?",
        "10 tabs have 未保存的更改. 你的更改将会丢失 if you 强制关闭 these tabs. 确定吗 you want to 强制关闭?",
        "Run order",
        "Runner - 我的工作区",
        "Drag a collection or folder from your sidebar to get started",
        "Run Sequence",
        "Drag a collection from the sidebar to run",
        "Runner sends all your requests sequentially and gathers test results.",
        "Choose how to run your collection",
        "Schedule runs",
        "Periodically run collection at a specified time on the Postman Cloud.",
        "Automate runs via CLI",
        "Configure CLI command to run on your build pipeline.",
        "Run configuration",
        "Iterations",
        "No. of times to loop through the collection during the run.",
        "Test data file",
        "An interval delay before each request.",
        "Test your APIs with various inputs by uploading a dataset. Only JSON and CSV files are accepted.",
        "Persist responses for a session",
        "Responses are persisted only for a session and not saved permanently. Enabling this may impact performance for large collection runs.",
        "Turn off logs during run",
        "Turn off logging to the Postman Console to improve performance during the run",
        "Stop run if an error occurs",
        "Keep variable values",
        "Enabling this will write the value of the variables at the end of the run to its value in the session.",
        "Run collection without using stored cookies",
        "Save cookies after collection run",
        "Update the cookies stored in this session and save them to your cookie manager.",
        "Start run",
        "Functional",
        "Performance",
        "Scheduled",
        "Last 100 runs",
        "Run by",
        "Run status",
        "Source",
        "Start time",
        "Duration",
        "All tests",
        "Passed",
        "Skipped",
        "Avg. Resp. Time",
        "Your collection has not been run yet",
        "Runs triggered for this collection via",
        "and Postman CLI.",
        "Run this collection in the 集合运行器.",
        "Set your performance test",
        "设置 your performance test",
        "Load profile",
        "Virtual users",
        "Determines how the number of virtual users changes during the test.",
        "Each user runs the collection in parallel and repeatedly for the test duration.",
        "Test duration",
        "Data file enables you to assign unique datasets to each virtual user, simulating real-world scenarios.",
        "20 virtual users run for 10 minutes, each executing all requests sequentially.",
        "Set conditions to determine if the test passes or fails based on performance metrics.",
        "New Session - 我的工作区",
        "New proxy session",
        "Capture HTTPS traffic",
        "Use Postman 的 proxy to inspect HTTPS communication from your Android, iOS, Linux, macOS, and Windows devices and build client-side applications faster!",
        "System traffic",
        "Browser traffic",
        "Capture and inspect app traffic on your devices.",
        "To capture and inspect traffic on your browser, download Postman 的 interceptor extension.",
        "We'll request to install certificate the first time you start a proxy session.",
        "Start proxy session",
        "Internal Workspace",
        "Last activity",
        "Workspace ID:",
        "Toggle left sidebar Ctrl+" + String.fromCharCode(92),
        "Toggle bottom bar Ctrl+" + String.fromCharCode(96),
        "Toggle right sidebar Ctrl+Alt+" + String.fromCharCode(92),
        "Toggle switch, currently OFF",
        "Toggle switch, currently ON",
        "Almost there! We’re loading your Vault.",
        "Filter secrets",
        "Add new secret",
        "Allowed domains",
        "Store your sensitive data locally. Local Vault secrets work across workspaces, available only to you, stay local, and aren't synced.",
        "Add description",
        "Add Value",
        "Bottom bar",
        "Export globals",
        "Save request to a collection",
        "Save Untitled Request to a collection",
        "Document this request...",
        "QUERY",
        "GRAPHQL VARIABLES",
        "Define variables in JSON format to use in the query",
        "Auto Fetch",
        "Could not auto fetch. Make sure Authorization, URL & selected environment are valid. Check console for more details.",
        "Editor content",
        "Description only appears in Postman documentation and is not sent with your request.",
        "Key-Value Edit",
        "Rows are separated by new lines",
        "Keys and values are separated by :",
        "Prepend // to any row you want to add but keep disabled",
        "No request history",
        "Send the request and browse through its history.",
        "Clear response",
        "Auth Type",
        "Edit Auth in collection",
        "This request does not use any authorization.",
        "The authorization header will be automatically generated when you send the request. Learn more about authorization.",
        "Hawk Authentication",
        "AWS Signature",
        "NTLM Authentication",
        "Akamai EdgeGrid",
        "ASAP (Atlassian)",
        "New Chat",
        "Describe what you need. Press @ for context, / for Skills.",
        "Build APIs faster with AI!",
        "Start using 智能代理模式!",
        "Your plan includes 50 AI credits per month to use 智能代理模式.",
        "Your plan includes 50 AI credits per month 可用于智能代理模式。",
        "Share request",
        "Switch AI model",
        "Couldn’t initialize Agent Mode",
        "Looks like we couldn't initialize Agent Mode for you. Try restarting your app, or contact Postman Support at help@postman.com.",
        "Close dropdown",
        "Packages",
        "Snippets",
        "Presets",
        "Pre-request",
        "Post-response",
        "Pre-req",
        "Post-res",
        "Use JavaScript to write tests, visualize response, and more.",
        "Use JavaScript to write tests, visualize responses, and more.",
        "These headers will be automatically added and sent with the request. Click to view and modify these headers.",
        "Type a new method",
        "No new changes to save.",
        "Click Send to get a response",
        "DO YOU WANT TO SAVE?",
        "This tab Untitled Request has unsaved changes which will be lost if you choose to close it. Save these changes to avoid losing your work.",
        "This tab https://example.com 有未保存的更改 如果选择关闭，这些更改将会丢失。 保存这些更改 to avoid losing your work.",
        "has unsaved changes which will be lost if you choose to close it. Save these changes to avoid losing your work.",
        "有未保存的更改 如果选择关闭，这些更改将会丢失。 保存这些更改 to avoid losing your work.",
        "Always discard unsaved changes when closing a tab",
        "You'll no longer be prompted to save changes when closing a tab. You can change this anytime from your Settings.",
        "Discard changes",
        "Create account to save",
        "Local Vault",
        "Store your API secrets locally in vault.",
        "Workspace activity",
        "Recently closed",
        "Loading Folder...",
        "A workspace lets you organize and collaborate on APIs. Learn more about workspaces",
        "Learn More",
        "Workspace name",
        "Owned By",
        "Waiting for the crew... No connections yet!",
        "When you are invited to join external workspaces by your partners, they will appear here, ready for you to explore and collaborate.",
        "Make your APIs, collections, and workspaces easily discoverable for everyone in your organization.",
        "Upgrade to access the Private API Network",
        "The Private API Network is available on Enterprise plans. Upgrade your plan to unlock centralised API discovery for your organization.",
        "Add workspaces to the Private API Network",
        "Make workspaces easily discoverable for your team by adding them to the network.",
        "Welcome to the Private API Network",
        "This is a central directory of all workspaces in your organization. Your teams can discover available workspaces and use tags to organize and find them easily.",
        "Request workspaces from where you build",
        "Add workspaces directly from where you create and manage them.",
        "Get quick approvals from designated managers",
        "Add comments and let Team Managers and Network Managers help review and curate workspaces with intent.",
        "Added workspaces",
        "Review",
        "What's New",
        "Find out new updates or content from publishers and the community.",
        "Browse APIs",
        "New...",
        "Import...",
        "Exit",
        "Toggle Workbench",
        "Swap Left and Right Sidebar",
        "Reset Layout",
        "Go Back",
        "Go Forward",
        "Next Tab",
        "Previous Tab",
        "Show Postman Console",
        "Disable Hardware Acceleration",
        "Region Preference for New Accounts",
        "Use US Region by Default",
        "Use EU Region by Default",
        "Always Ask for Region Selection",
        "Trust and Security",
        "Github Issues",
        "GitHub Issues",
        "Build and test APIs within your team.",
        "Change",
        "People in the workspace",
        "People in this workspace",
        "Start live session",
        "Manage People",
        "Sidebar panels",
        "Customize which panels appear in the sidebar for everyone in this workspace.",
        "Workspace theme",
        "Make the workspace unique by having its theme reflect its content and your team's identity. These changes will reflect for all your members.",
        "Accent color",
        "Color for buttons and highlights.",
        "No color chosen",
        "No color cho en",
        "Theme color",
        "Overall interface color.",
        "Apply theme",
        "Reset to default",
        "Delete workspace",
        "Once deleted, a workspace is gone forever along with its data."
      ];
      const menuEnglishPattern = /New Request|Duplicate Tab|Selected Tab|Recently Closed Tabs|Close Tab|Force Close|Close Other|Close All|Reveal in Sidebar|Clone|flow link|analytics/i;
      const bodyText = document.body ? document.body.innerText : "";
      const localizer = window.__POSTMAN_ZH_LOCALIZER__;
      const translationProbe = {
        available: !!(localizer && typeof localizer.translate === "function"),
        untranslated: [],
        englishHits: []
      };
      if (translationProbe.available) {
        translationProbe.untranslated = translationProbeTargets.filter((text) => {
          return localizer.translate(text) === text;
        });
        translationProbe.englishHits = translationProbeTargets.map((text) => {
          const output = localizer.translate(text);
          const hits = [
            "tabs have",
            "tab has",
            "Your changes",
            "if you",
            "these tabs",
            "this tab",
            "you want to",
            "Force Close",
            "Force 关闭",
            "Confirm force close",
            "Establish a connection",
            "Type to filter",
            "Send request to get",
            "Agent Mode is not available",
            "Contact your team admin",
            "documentation to help others",
            "Enterprise Trial",
            "Your team grew",
            "Keep your team working",
            "Take the next step",
            "Contact us",
            "Generate SDK",
            "No collections or specifications",
            "Active webhook",
            "New Webhook",
            "Receive a Mock Event",
            "Every hour",
            "Integrations will be created",
            "More templates",
            "collection templates",
            "Postman has encountered an error",
            "Filter variables",
            "variable type",
            "variable values",
            "Share environment",
            "Set active",
            "Autosave changes",
            "Audit logs",
            "Public elements",
            "Enter vault key",
            "Reset vault",
            "Open Vault",
            "Created on",
            "Couldn't find the key",
            "Save this key",
            "variable type secret",
            "current value of a variable",
            "Sign up to save",
            "lightweight API Client",
            "save and back up",
            "unlock this feature",
            "Workspaces help",
            "stay organized",
            "Recently Closed Tabs",
            "Duplicate Selected Tab",
            "Close Selected Tab",
            "Selected Tab",
            "Close All but Selected Tab"
          ].filter((needle) => String(output || "").includes(needle));
          return hits.length ? { input: text, output, hits } : null;
        }).filter(Boolean);
      } else {
        translationProbe.untranslated = translationProbeTargets;
        translationProbe.englishHits = translationProbeTargets.map((text) => ({ input: text, output: text, hits: ["probe unavailable"] }));
      }
      const tabs = Array.from(document.querySelectorAll("[data-tab-id]")).slice(0, 10).map((el) => {
        const rect = el.getBoundingClientRect();
        return {
          text: el.innerText || "",
          tabId: el.dataset && el.dataset.tabId || "",
          className: String(el.className || ""),
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height
        };
      });
      const output = {
        url: location.href,
        title: document.title,
        localized: document.documentElement.getAttribute("data-postman-zh-localized"),
        bodyEnglishHits: knownEnglish.filter((text) => bodyText.includes(text)),
        translationProbe,
        tabs,
        managerPatched: false,
        contextMenuSkipped: false,
        menuLabels: null,
        menuEnglishHits: null,
        error: null
      };

      try {
        const manager = window.pm && window.pm.contextMenuManager;
        output.managerPatched = !!(manager && manager.__postmanZhBuildMenuPatched);
        const target = tabs.length ? Array.from(document.querySelectorAll("[data-tab-id]")).find((el) => /GET/.test(el.innerText || "")) || document.querySelector("[data-tab-id]") : null;
        if (!manager || typeof manager.buildMenu !== "function") {
          output.error = "contextMenuManager is unavailable";
        } else if (!target) {
          output.contextMenuSkipped = true;
          output.menuLabels = [];
          output.menuEnglishHits = [];
        } else {
          const rect = target.getBoundingClientRect();
          const eventLike = {
            target,
            clientX: rect.left + Math.min(30, rect.width / 2),
            clientY: rect.top + Math.min(10, rect.height / 2),
            preventDefault() {},
            stopPropagation() {}
          };
          const menu = manager.buildMenu(eventLike);
          output.menuLabels = menu && menu.items ? Array.from(menu.items).map((item) => item.label || "") : [];
          output.menuEnglishHits = output.menuLabels.filter((label) => menuEnglishPattern.test(label || ""));
        }
      } catch (error) {
        output.error = String(error && error.stack || error);
      }
      return output;
    })()`;

    const evaluation = await cdp.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true
    });

    if (evaluation.exceptionDetails) {
      throw new Error(JSON.stringify(evaluation.exceptionDetails));
    }

    const result = evaluation.result && evaluation.result.value;
    if (!result) {
      throw new Error("No verification result returned from Postman.");
    }
    result.updatePatch = inspectUpdatePatch(postmanDir);
    result.externalUrlPatch = inspectExternalUrlPatch(postmanDir);
    result.mainMenuPatch = inspectMainMenuPatch(postmanDir);

    const failures = [];
    if (result.localized !== "true") {
      failures.push("data-postman-zh-localized is not true");
    }
    if (/\bMy Workspace\b|\bTeam Workspace\b|\bPersonal Workspace\b/.test(result.title || "")) {
      failures.push(`title English hit: ${result.title}`);
    }
    if (result.bodyEnglishHits && result.bodyEnglishHits.length) {
      failures.push(`body English hits: ${result.bodyEnglishHits.join(", ")}`);
    }
    if (!result.translationProbe || !result.translationProbe.available) {
      failures.push("translation probe is unavailable");
    } else if (result.translationProbe.untranslated && result.translationProbe.untranslated.length) {
      failures.push(`translation probe untranslated: ${result.translationProbe.untranslated.join(", ")}`);
    } else if (result.translationProbe.englishHits && result.translationProbe.englishHits.length) {
      failures.push(`translation probe English hits: ${JSON.stringify(result.translationProbe.englishHits)}`);
    }
    if (result.error) {
      failures.push(result.error);
    }
    if (result.menuEnglishHits && result.menuEnglishHits.length) {
      failures.push(`context-menu English hits: ${result.menuEnglishHits.join(", ")}`);
    }
    if (!result.contextMenuSkipped && (!Array.isArray(result.menuLabels) || !result.menuLabels.length)) {
      failures.push("context-menu labels were not captured");
    }
    if (expectUpdatesDisabled && (!result.updatePatch || !result.updatePatch.disabled)) {
      failures.push(`update patch is not disabled: ${JSON.stringify(result.updatePatch)}`);
    }
    if (!result.externalUrlPatch || !result.externalUrlPatch.installed) {
      failures.push(`external URL quote patch is not installed: ${JSON.stringify(result.externalUrlPatch)}`);
    }
    if (!result.mainMenuPatch || !result.mainMenuPatch.installed) {
      failures.push(`main menu patch is incomplete: ${JSON.stringify(result.mainMenuPatch)}`);
    }

    console.log(escapeForConsole(result));

    if (failures.length) {
      console.error("[postman-zh] VERIFY FAILED");
      for (const failure of failures) {
        console.error(`- ${failure}`);
      }
      process.exit(1);
    }

    console.log("[postman-zh] VERIFY PASSED");
  } finally {
    cdp.close();
  }
}

main().catch((error) => {
  console.error("[postman-zh] VERIFY ERROR");
  console.error(error && error.stack || error);
  process.exit(1);
});
