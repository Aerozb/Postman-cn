#!/usr/bin/env node
"use strict";

// 查看 GitHub 项目数据：Star / Fork / 关注、Release 下载量、最近 14 天访问与克隆。
// 由 postman-zh.bat stats 调用。
//
// 走 gh CLI 而不是自己拿令牌：gh 已经管好了认证，脚本里不出现也不存任何 token。
// 只读接口，不改仓库任何东西。
//
// 两个数据来源的权限不同，别混：
//   Star / Fork / Release 下载量  → 公开数据，任何人都能看
//   访问量 / 克隆 / 来源站点      → 需要仓库 push 权限，别人看不到你的
//
// 默认只打印中文摘要；--details 才展开每个 Release 的资产明细和来源站点。

const { execFileSync } = require("child_process");

const SHOW_DETAILS = process.argv.includes("--details");

// 中文占两列，按显示宽度补空格，否则中英混排的表格对不齐
function dispWidth(text) {
  let w = 0;
  for (const ch of String(text)) {
    const c = ch.codePointAt(0);
    const wide = c >= 0x1100 && (
      c <= 0x115f || c === 0x2329 || c === 0x232a ||
      (c >= 0x2e80 && c <= 0xa4cf && c !== 0x303f) ||
      (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe6f) || (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6)
    );
    w += wide ? 2 : 1;
  }
  return w;
}

function padEnd(text, width) {
  const gap = width - dispWidth(text);
  return String(text) + (gap > 0 ? " ".repeat(gap) : "");
}

function padStart(text, width) {
  const gap = width - dispWidth(text);
  return (gap > 0 ? " ".repeat(gap) : "") + String(text);
}

function formatDate(iso) {
  if (!iso) return "未知";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}

// 调 gh api。失败不抛：某些接口需要 push 权限，拿不到就跳过那一节，
// 别让整条命令挂掉。
function ghApi(endpoint) {
  try {
    const out = execFileSync("gh", ["api", endpoint, "--cache", "60s"], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    return { ok: true, data: JSON.parse(out) };
  } catch (e) {
    const stderr = String((e && e.stderr) || "");
    let reason = "调用失败";
    if (/HTTP 404/.test(stderr)) reason = "接口返回 404（可能没有权限或仓库名不对）";
    else if (/HTTP 403/.test(stderr)) reason = "接口返回 403（权限不足或触发限额）";
    else if (/not logged/i.test(stderr) || /gh auth login/.test(stderr)) reason = "gh 未登录";
    else if (/ENOENT/.test(String((e && e.code) || ""))) reason = "找不到 gh 命令";
    return { ok: false, reason: reason };
  }
}

// 仓库全名：优先问 gh 当前目录对应的仓库，拿不到再退到写死的默认值。
function resolveRepo() {
  const explicit = process.argv.indexOf("--repo");
  if (explicit >= 0 && process.argv[explicit + 1]) {
    return process.argv[explicit + 1];
  }
  try {
    const out = execFileSync("gh", ["repo", "view", "--json", "nameWithOwner"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true
    });
    const parsed = JSON.parse(out);
    if (parsed && parsed.nameWithOwner) return parsed.nameWithOwner;
  } catch (e) {}
  return "Aerozb/Postman-cn";
}

const REPO = resolveRepo();

function section(title) {
  console.log("");
  console.log("=== " + title + " ===");
}

function main() {
  console.log("GitHub 项目数据：" + REPO);

  // ── 基础热度 ────────────────────────────────────────
  const repo = ghApi("repos/" + REPO);
  if (!repo.ok) {
    console.log("");
    console.log("读取仓库信息失败：" + repo.reason);
    console.log("请先确认 gh 已登录（gh auth status），再重试。");
    process.exit(1);
  }
  const r = repo.data;

  section("基础热度");
  const rows = [
    ["Star", r.stargazers_count],
    ["Fork", r.forks_count],
    ["Watch（关注）", r.subscribers_count],
    ["开放 Issue", r.open_issues_count]
  ];
  for (const [label, value] of rows) {
    console.log("  " + padEnd(label, 16) + padStart(String(value), 6));
  }
  console.log("  " + padEnd("创建于", 16) + padStart(formatDate(r.created_at), 12));
  console.log("  " + padEnd("最近推送", 16) + padStart(formatDate(r.pushed_at), 12));

  // ── Release 下载量 ──────────────────────────────────
  const releases = ghApi("repos/" + REPO + "/releases?per_page=100");
  section("Release 下载量");
  if (!releases.ok) {
    console.log("  读取失败：" + releases.reason);
  } else if (!releases.data.length) {
    console.log("  还没有发布过 Release。");
  } else {
    let total = 0;
    const lines = [];
    for (const rel of releases.data) {
      const sum = (rel.assets || []).reduce((n, a) => n + (a.download_count || 0), 0);
      total += sum;
      lines.push({ tag: rel.tag_name || "(无标签)", date: formatDate(rel.published_at), count: sum, assets: rel.assets || [] });
    }
    console.log("  " + padEnd("标签", 14) + padEnd("发布日期", 12) + padStart("下载", 8));
    for (const line of lines) {
      console.log("  " + padEnd(line.tag, 14) + padEnd(line.date, 12) + padStart(String(line.count), 8));
      if (SHOW_DETAILS) {
        for (const a of line.assets) {
          console.log("      " + padEnd(a.name, 34) + padStart(String(a.download_count || 0), 8) +
            "  " + (a.size / 1048576).toFixed(1) + " MB");
        }
      }
    }
    console.log("  " + padEnd("累计", 26) + padStart(String(total), 8));
    console.log("");
    console.log("  注意：覆盖同一个标签重新发布会让该 Release 的下载量清零（删旧建新），");
    console.log("  所以这个数字只能看趋势，不适合当精确统计。");
  }

  // ── 流量数据（需要 push 权限）───────────────────────
  const views = ghApi("repos/" + REPO + "/traffic/views");
  const clones = ghApi("repos/" + REPO + "/traffic/clones");
  section("最近 14 天流量（仅仓库管理员可见）");
  if (!views.ok || !clones.ok) {
    console.log("  读取失败：" + (views.ok ? clones.reason : views.reason));
    console.log("  这组数据需要仓库的 push 权限，且 GitHub 只保留最近 14 天。");
  } else {
    console.log("  " + padEnd("页面访问", 16) + padStart(String(views.data.count || 0), 6) +
      " 次，独立访客 " + (views.data.uniques || 0));
    console.log("  " + padEnd("克隆", 16) + padStart(String(clones.data.count || 0), 6) +
      " 次，独立来源 " + (clones.data.uniques || 0));

    if (SHOW_DETAILS && Array.isArray(views.data.views)) {
      console.log("");
      console.log("  逐日访问：");
      for (const day of views.data.views) {
        console.log("    " + formatDate(day.timestamp) + "  访问 " +
          padStart(String(day.count), 4) + "  访客 " + padStart(String(day.uniques), 4));
      }
    }
  }

  // ── 来源与热门页面（同样需要 push 权限）─────────────
  if (SHOW_DETAILS) {
    const referrers = ghApi("repos/" + REPO + "/traffic/popular/referrers");
    section("最近 14 天访问来源");
    if (!referrers.ok) {
      console.log("  读取失败：" + referrers.reason);
    } else if (!referrers.data.length) {
      console.log("  暂无数据。");
    } else {
      for (const ref of referrers.data) {
        console.log("  " + padEnd(ref.referrer, 26) + padStart(String(ref.count), 6) +
          " 次，独立 " + ref.uniques);
      }
    }

    const paths = ghApi("repos/" + REPO + "/traffic/popular/paths");
    section("最近 14 天热门页面");
    if (!paths.ok) {
      console.log("  读取失败：" + paths.reason);
    } else if (!paths.data.length) {
      console.log("  暂无数据。");
    } else {
      for (const p of paths.data.slice(0, 10)) {
        console.log("  " + padStart(String(p.count), 6) + " 次  " + String(p.path).slice(0, 60));
      }
    }
  }

  console.log("");
  if (!SHOW_DETAILS) {
    console.log("加 --details 可看每个 Release 的资产明细、逐日访问、来源站点和热门页面。");
  }
}

main();
