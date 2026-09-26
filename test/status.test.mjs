/**
 * MCP 行运行态读取的测试：loader 条目查找、fiber 阶段映射、已注册工具数。
 *
 * 重点覆盖两个踩过的坑：
 *   1. loader 会给 `insert:` 进来的行加 `include:` 前缀，按字面 id 查会永远查不到，
 *      表现为服务器在跑但面板一直显示「加载中」；
 *   2. 工具名前缀是 `mcp__<serverName>__`，serverName 变一位就不该计数。
 */

import assert from "node:assert/strict";
import { fiberPhaseOf, getLoaderEntry, mcpToolCount, mcpToolNames, waitForLoaderState } from "../lib/mcp/status.js";

let pass = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(name);
    console.log(`  ✗ ${name}${detail === undefined ? "" : `　（${detail}）`}`);
  }
}

const entryOf = (id, state) => ({ id, fiber: { state } });
const ctxWith = (entries) => ({ loader: { entries: () => entries[Symbol.iterator]() } });

// ─────────────────── [1] getLoaderEntry ───────────────────

console.log("\n[1] getLoaderEntry");
const plain = ctxWith([entryOf("mcp-market-memory", 2)]);
check("精确 id 命中", getLoaderEntry(plain, "mcp-market-memory") !== undefined);

// 实测形态：cordis.patch.yml 的 insert 行运行时 id 会带 include: 前缀。
const prefixed = ctxWith([
  entryOf("include:mcp-resources", 2),
  entryOf("include:mcp-market", 2),
  entryOf("include:mcp-market-memory", 2),
]);
const hit = getLoaderEntry(prefixed, "mcp-market-memory");
check("带 include: 前缀时仍能命中", hit !== undefined);
check("命中的是正确那条", hit && hit.id === "include:mcp-market-memory");
check("前缀行不会串到别的条目", getLoaderEntry(prefixed, "mcp-market").id === "include:mcp-market");
check("不存在的 id 返回 undefined", getLoaderEntry(prefixed, "mcp-market-nope") === undefined);

check("精确匹配优先于后缀匹配", getLoaderEntry(ctxWith([entryOf("include:x", 1), entryOf("x", 2)]), "x").fiber.state === 2);
check("空 id 返回 undefined", getLoaderEntry(prefixed, "") === undefined);
check("id 非字符串返回 undefined", getLoaderEntry(prefixed, 42) === undefined);
check("没有 loader 服务时返回 undefined", getLoaderEntry({}, "x") === undefined);
check("loader.entries 不是函数时返回 undefined", getLoaderEntry({ loader: { entries: 1 } }, "x") === undefined);
check("ctx 为 undefined 不抛", getLoaderEntry(undefined, "x") === undefined);
check(
  "不以后缀偷懒匹配（abcx 不该命中 x）",
  getLoaderEntry(ctxWith([entryOf("abcx", 2)]), "x") === undefined,
);

// ─────────────────── [2] fiberPhaseOf ───────────────────

console.log("\n[2] fiberPhaseOf");
check("0 → pending", fiberPhaseOf(0) === "pending");
check("1 → loading", fiberPhaseOf(1) === "loading");
check("2 → active（实测运行中的值）", fiberPhaseOf(2) === "active");
check("3 → failed", fiberPhaseOf(3) === "failed");
check("4 → null（无此阶段）", fiberPhaseOf(4) === null);
check("5 → unloading", fiberPhaseOf(5) === "unloading");
check("越界码返回 null", fiberPhaseOf(99) === null);
check("非数字返回 null", fiberPhaseOf("2") === null);
check("undefined 返回 null", fiberPhaseOf(undefined) === null);

// ─────────────────── [3] mcpToolCount ───────────────────

console.log("\n[3] mcpToolCount");
const tools = {
  schemas: () => [
    { name: "list_mcp_resources" },
    { name: "mcp__memory__create_entities" },
    { name: "mcp__memory__search_nodes" },
    { name: "mcp__memory__open_nodes" },
    { name: "bash" },
    { notAName: true },
  ],
};
check("按 mcp__<name>__ 前缀计数", mcpToolCount({ tools }, "memory") === 3);
// 前缀必须带着末尾的 __：否则 serverName 为 memo 时，mcp__memory__* 也会被吞进来。
const overlapping = {
  schemas: () => [{ name: "mcp__memory__create_entities" }, { name: "mcp__memo__own_tool" }],
};
check(
  "serverName 短一位不误匹配（memo 不吞 memory 的工具）",
  mcpToolCount({ tools: overlapping }, "memo") === 1,
);
check("无工具的服务返回 0", mcpToolCount({ tools }, "nope") === 0);
check("没有 tools 服务返回 0", mcpToolCount({}, "memory") === 0);
check("schemas 不是函数返回 0", mcpToolCount({ tools: { schemas: 1 } }, "memory") === 0);
check("schemas 返回非数组返回 0", mcpToolCount({ tools: { schemas: () => null } }, "memory") === 0);
check("schemas 抛错不炸", mcpToolCount({ tools: { schemas: () => { throw new Error("boom"); } } }, "memory") === 0);

// ─────────────────── [4] mcpToolNames ───────────────────

console.log("\n[4] mcpToolNames");
// 「测试连接」对已装载的服务直接读这里，省掉一次真连；名字必须剥干净前缀，
// 否则界面上会显示成 mcp__memory__search_nodes 而不是 search_nodes。
const named = mcpToolNames({ tools }, "memory");
check("返回剥掉前缀的工具名", named.length === 3 && named.includes("search_nodes"));
check("名字里不带 mcp__ 前缀", named.every((name) => !name.startsWith("mcp__")));
check("顺序与宿主一致", named[0] === "create_entities" && named[2] === "open_nodes");
check("不夹带别的服务的工具", !named.includes("list_mcp_resources") && !named.includes("bash"));
check("无匹配服务返回空数组", Array.isArray(mcpToolNames({ tools }, "nope")) && mcpToolNames({ tools }, "nope").length === 0);
check("没有 tools 服务返回空数组", mcpToolNames({}, "memory").length === 0);
check("schemas 抛错返回空数组", mcpToolNames({ tools: { schemas: () => { throw new Error("boom"); } } }, "memory").length === 0);
check("schemas 返回非数组返回空数组", mcpToolNames({ tools: { schemas: () => null } }, "memory").length === 0);
check("serverName 为空返回空数组", mcpToolNames({ tools }, "").length === 0);
check("serverName 非字符串返回空数组", mcpToolNames({ tools }, 42).length === 0);
// 名字恰好只等于前缀（`mcp__memory__`）时剥完是空串，不该出现在列表里 ——
// 界面上会渲染成一个看不见的条目。
check(
  "剥完为空的名字被丢弃",
  mcpToolNames({ tools: { schemas: () => [{ name: "mcp__memory__" }, { name: "mcp__memory__ok" }] } }, "memory").join(",") === "ok",
);
check("计数与名字列表同源", mcpToolCount({ tools }, "memory") === named.length);

// ─────────────────── [5] waitForLoaderState ───────────────────

console.log("\n[4] waitForLoaderState");
const ctx = ctxWith([entryOf("include:mcp-market-memory", 2)]);
check(
  "已满足的谓词立即返回",
  (await waitForLoaderState(ctx, "mcp-market-memory", (e) => e?.fiber?.state === 2, 300)) === true,
);
check(
  "永不满足的谓词超时返回 false",
  (await waitForLoaderState(ctx, "mcp-market-memory", () => false, 300)) === false,
);

// ─────────────────── 汇总 ───────────────────

console.log(`\n结果：${pass} 通过 / ${failures.length} 失败`);
if (failures.length > 0) {
  console.log(`失败项：${failures.join("、")}`);
  process.exitCode = 1;
}
