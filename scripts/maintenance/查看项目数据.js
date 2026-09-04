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
// **明细默认就出**（2026-09-04 用户要求）：这是个纯查看命令，用户点它就是想看数据，
// 再让人记一个 --details 没意义。逐日访问那一段最长（14 行），默认折叠成一行
// 「最近 7 天走势」，想看完整逐日再加 --full。这样默认输出能压在一屏内，
// 不至于把前面的 Star/下载量顶出窗口。
const { execFileSync } = require("child_process");

// --full 才展开逐日访问；来源站点和热门页面这类短表默认就出
const SHOW_FULL = process.argv.includes("--full") || process.argv.includes("--details");

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
  // 一行放两项，省一半行数——默认输出必须压在一屏内，否则 cmd 窗口会把
  // 最上面的 Star/Fork 滚出去（用户看不到就等于没有）
  console.log("  " + padEnd("Star", 12) + padStart(String(r.stargazers_count), 6) +
    "     " + padEnd("Fork", 12) + padStart(String(r.forks_count), 6));
  console.log("  " + padEnd("关注", 12) + padStart(String(r.subscribers_count), 6) +
    "     " + padEnd("开放 Issue", 12) + padStart(String(r.open_issues_count), 6));
  console.log("  " + padEnd("创建于", 12) + padStart(formatDate(r.created_at), 6) +
    "     " + padEnd("最近推送", 12) + padStart(formatDate(r.pushed_at), 6));

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
    console.log("  " + padEnd("标签", 12) + padEnd("发布日期", 12) + padStart("下载", 7) + "   构成");
    for (const line of lines) {
      // 资产明细压进同一行：每个 Release 只有 asar + zip 两个，单独占行会把
      // 前面的 Star/Fork 顶出窗口（2026-09-04 用户报「看完数据闪退」的直接原因）
      const parts = line.assets.map((a) => {
        const kind = /\.zip$/i.test(a.name) ? "绿色版" : (/app\.asar$/i.test(a.name) ? "asar" : a.name);
        return kind + " " + (a.download_count || 0);
      }).join(" + ");
      console.log("  " + padEnd(line.tag, 12) + padEnd(line.date, 12) +
        padStart(String(line.count), 7) + "   " + parts);
    }
    console.log("  " + padEnd("累计", 24) + padStart(String(total), 7));
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

    if (Array.isArray(views.data.views) && views.data.views.length) {
      const days = views.data.views;
      if (SHOW_FULL) {
        console.log("");
        console.log("  逐日访问：");
        for (const day of days) {
          console.log("    " + formatDate(day.timestamp) + "  访问 " +
            padStart(String(day.count), 4) + "  访客 " + padStart(String(day.uniques), 4));
        }
      } else {
        // 默认只给最近 7 天的一行走势，够看趋势又不占屏；--full 展开全部 14 天
        const recent = days.slice(-7);
        console.log("  " + padEnd("最近 7 天走势", 16) +
          recent.map((d) => d.count).join(" → "));
        console.log("  " + padEnd("", 16) + "（" + formatDate(recent[0].timestamp) +
          " 起，加 --full 看完整 14 天逐日）");
      }
    }
  }

  // ── 来源与热门页面（同样需要 push 权限）─────────────
  {
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
      // 默认给前 6 条够看重点；--full 出全部
      const top = SHOW_FULL ? paths.data : paths.data.slice(0, 6);
      for (const p of top) {
        console.log("  " + padStart(String(p.count), 6) + " 次  " + String(p.path).slice(0, 60));
      }
      if (!SHOW_FULL && paths.data.length > top.length) {
        console.log("  （还有 " + (paths.data.length - top.length) + " 条，加 --full 看全部）");
      }
    }
  }

  console.log("");
}

main();
