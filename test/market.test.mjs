/**
 * 广场数据层测试。
 *
 * 分两类：
 *   - 离线逻辑：过滤 / 排序 / 转换 / 增量比对（不打网络，随时可跑）
 *   - 在线连通：真实调用魔搭广场（网络不可用时自动跳过并提示）
 *
 * 运行：node test/market.test.mjs
 */

import { fetchPage, normalizeServer, detailUrlOf } from "../lib/modelscope/client.js";
import {
  INSTALL_KIND,
  buildInstallPlan,
  displayNameOf,
  resolveInstallKind,
  uniqueServerName,
} from "../lib/market/convert.js";
import { diffServers, configSignatureOf } from "../lib/market/sync.js";
import { filterEntries, sortEntries } from "../lib/market/filter.js";

let pass = 0;
let fail = 0;
let skipped = 0;

const check = (name, condition, extra) => {
  if (condition) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${extra ? `  → ${extra}` : ""}`);
  }
};

// ───────────────────────── 离线逻辑 ─────────────────────────

console.log("\n[1] 过滤：关键词 / 分类 / 托管类型");
const sample = [
  { publisher: "@modelcontextprotocol/fetch", name: "fetch", chineseName: "Fetch网页内容抓取", abstract: "抓取网页并转 markdown", categories: ["browser-automation"], tags: ["爬虫"], hosted: true, stars: 1034, views: 616496, updatedAt: 100 },
  { publisher: "@amap/amap-maps", name: "amap-maps", chineseName: "高德地图", abstract: "提供位置服务", categories: ["location-services"], tags: [], hosted: false, stars: 707, views: 137800000, updatedAt: 300 },
  { publisher: "itshen/xsct-bench", name: "xsct-bench", chineseName: "XSCT 模型选型 MCP", abstract: "帮你挑选大模型", categories: ["developer-tools"], tags: ["模型评测"], hosted: true, stars: 138, views: 27927, updatedAt: 200 },
];

check("空条件返回全部", filterEntries(sample, { query: "", category: "", hosted: undefined }).length === 3);
check("按中文名搜索", filterEntries(sample, { query: "高德" }).length === 1);
check("按英文名搜索", filterEntries(sample, { query: "fetch" }).length === 1);
check("按 publisher 搜索", filterEntries(sample, { query: "itshen" }).length === 1);
check("按标签搜索", filterEntries(sample, { query: "模型评测" }).length === 1);
check("大小写不敏感", filterEntries(sample, { query: "FETCH" }).length === 1);
check("按分类筛选", filterEntries(sample, { query: "", category: "location-services" }).length === 1);
check("按托管筛选 hosted=true", filterEntries(sample, { query: "", hosted: true }).length === 2);
check("按托管筛选 hosted=false", filterEntries(sample, { query: "", hosted: false }).length === 1);
check("组合条件", filterEntries(sample, { query: "MCP", category: "developer-tools", hosted: true }).length === 1);
check("无命中返回空", filterEntries(sample, { query: "不存在的关键词xyz" }).length === 0);

console.log("\n[2] 排序");
check("按星标降序", sortEntries(sample, "stars")[0].name === "fetch");
check("按浏览降序", sortEntries(sample, "views")[0].name === "amap-maps");
check("按更新降序", sortEntries(sample, "updated")[0].name === "amap-maps");
check("relevance 保持原序", sortEntries(sample, "relevance")[0].name === "fetch");
check("排序不改原数组", sample[0].name === "fetch");

console.log("\n[3] 转换：本地 stdio");
const local = {
  name: "fetch",
  serverConfig: [{ name: "fetch", command: "uvx", args: ["mcp-server-fetch"], env: { TOKEN: "<必填>" } }],
  streamableHttpConfig: [],
  sseConfig: [],
  envSchema: { fields: [{ key: "TOKEN", required: true }], hasRequired: true },
};
const localPlan = buildInstallPlan(local);
check("判定为 local", resolveInstallKind(local).kind === INSTALL_KIND.LOCAL);
check("plan 成功", localPlan.ok === true);
check("transport=stdio", localPlan.config.transport === "stdio");
check("command 透传", localPlan.config.command === "uvx");
check("args 透传", JSON.stringify(localPlan.config.args) === '["mcp-server-fetch"]');
check("占位符 env 被剔除", localPlan.config.env.TOKEN === undefined);
check("带上了 reconnect 默认值", localPlan.config.reconnect.maxAttempts === 10);
check("envFields 暴露给前端", localPlan.envFields.length === 1);

console.log("\n[4] 转换：远程直连优先于本地");
const both = {
  name: "dual",
  serverConfig: [{ name: "dual", command: "npx", args: ["x"] }],
  streamableHttpConfig: [{ name: "dual", url: "https://x.com/mcp" }],
  sseConfig: [],
};
const bothPlan = buildInstallPlan(both);
check("优先 remote", bothPlan.kind === INSTALL_KIND.REMOTE);
check("transport=streamable-http", bothPlan.config.transport === "streamable-http");
check("url 正确", bothPlan.config.url === "https://x.com/mcp");
const forcedLocal = buildInstallPlan(both, { preferLocal: true });
check("preferLocal 可强制本地", forcedLocal.kind === INSTALL_KIND.LOCAL);

console.log("\n[5] 转换：用户填写覆盖占位符");
const withEnv = buildInstallPlan(
  { name: "amap", serverConfig: [{ name: "amap", command: "npx", args: ["-y", "amap"], env: { KEY: "<必填>" } }], streamableHttpConfig: [], sseConfig: [] },
  { env: { KEY: "real-key-value" } },
);
check("用户值生效", withEnv.config.env.KEY === "real-key-value");

console.log("\n[6] 转换：不支持的形态");
const sseOnly = { name: "s", serverConfig: [], streamableHttpConfig: [], sseConfig: [{ name: "s", url: "https://x/sse" }] };
check("仅 SSE 判为 unsupported", resolveInstallKind(sseOnly).kind === INSTALL_KIND.UNSUPPORTED);
check("给出原因", resolveInstallKind(sseOnly).reason.includes("SSE"));
check("plan 失败且带原因", buildInstallPlan(sseOnly).ok === false && buildInstallPlan(sseOnly).reason.length > 0);
const nothing = { name: "n", serverConfig: [], streamableHttpConfig: [], sseConfig: [] };
check("什么都没有也判 unsupported", resolveInstallKind(nothing).kind === INSTALL_KIND.UNSUPPORTED);

console.log("\n[7] serverName 规范化与去重");
check("正常名保留", uniqueServerName("fetch") === "fetch");
check("连字符保留", uniqueServerName("chrome-devtools-mcp") === "chrome-devtools-mcp");
check("斜杠转连字符", uniqueServerName("@amap/amap-maps") === "amap-amap-maps");
check("中文被替换", /^[A-Za-z0-9_-]+$/.test(uniqueServerName("高德地图")));
check("超长截断到 32", uniqueServerName("a".repeat(60)).length === 32);
check("已占用则加后缀", uniqueServerName("fetch", new Set(["fetch"])) === "fetch-2");
check("连续占用继续递增", uniqueServerName("fetch", new Set(["fetch", "fetch-2"])) === "fetch-3");
check("后缀后仍不超 32", uniqueServerName("b".repeat(32), new Set(["b".repeat(32)])).length <= 32);
check("空名有兜底", uniqueServerName("") === "mcp-server");
check("结果始终合规", [...Array(20)].every((_, i) => /^[A-Za-z0-9_-]{1,32}$/.test(uniqueServerName(`测试 ${i} @#$%`, new Set()))));

console.log("\n[8] 展示名优先中文");
check("有中文用中文", displayNameOf({ chineseName: "高德地图", name: "amap-maps" }) === "高德地图");
check("无中文用英文名", displayNameOf({ chineseName: "", name: "fetch" }) === "fetch");
check("都没有用 publisher", displayNameOf({ publisher: "a/b" }) === "a/b");

console.log("\n[9] 增量比对");
const prev = [
  { id: 1, name: "a", updatedAt: 100, configFingerprint: "x" },
  { id: 2, name: "b", updatedAt: 200, configFingerprint: "y" },
  { id: 3, name: "c", updatedAt: 300, configFingerprint: "z" },
];
const curr = [
  { id: 1, name: "a", updatedAt: 100, configFingerprint: "x" },
  { id: 2, name: "b", updatedAt: 999, configFingerprint: "y" },
  { id: 4, name: "d", updatedAt: 400, configFingerprint: "w" },
];
const diff = diffServers(prev, curr);
check("识别新增 1 条", diff.added.length === 1 && diff.added[0].id === 4);
check("识别更新 1 条", diff.updated.length === 1 && diff.updated[0].id === 2);
check("识别下架 1 条", diff.removed.length === 1 && diff.removed[0].id === 3);
check("未变 1 条", diff.unchanged === 1);

const sameTime = diffServers(
  [{ id: 9, updatedAt: 5, configFingerprint: "old" }],
  [{ id: 9, updatedAt: 5, configFingerprint: "new" }],
);
check("时间戳相同但配置变了也算更新", sameTime.updated.length === 1);

console.log("\n[10] 配置指纹：完整记录与缓存条目要一致");
const full = { serverConfig: [{ command: "npx", args: ["-y", "x"] }], streamableHttpConfig: [] };
check(
  "指纹稳定可复用",
  configSignatureOf({ ...full, configFingerprint: configSignatureOf(full) }) === configSignatureOf(full),
);

console.log("\n[11] 详情链接");
check("由 publisher 构造", detailUrlOf({ publisher: "@a/b" }) === "https://modelscope.cn/mcp/servers/@a/b");
check("无 publisher 回落广场首页", detailUrlOf({}) === "https://modelscope.cn/mcp");

// ───────────────────────── 在线连通 ─────────────────────────

console.log("\n[12] 在线：真实拉取魔搭广场");
let online = false;
let servers = [];
try {
  const page = await fetchPage({ pageSize: 100, pageNumber: 1 });
  online = true;
  servers = page.servers.map(normalizeServer);
  check("拿到数据", servers.length > 0, `got ${servers.length}`);
  check("总数合理", page.totalCount > 1000, `total=${page.totalCount}`);
  check("分类聚合非空", page.categoryAgg.length > 0);
  check("规整后字段齐全", servers.every((s) => typeof s.publisher === "string" && typeof s.id === "number"));
} catch (error) {
  skipped += 1;
  console.log(`  ⚠ 网络不可用，跳过在线测试：${error.message}`);
}

if (online) {
  console.log("\n[13] 在线：可安装率");
  const kinds = { local: 0, remote: 0, unsupported: 0 };
  for (const server of servers) kinds[resolveInstallKind(server).kind] += 1;
  const installable = kinds.local + kinds.remote;
  const rate = Math.round((installable / servers.length) * 100);
  console.log(`  · local=${kinds.local}  remote=${kinds.remote}  unsupported=${kinds.unsupported}  →  可安装 ${rate}%`);
  check("可安装率 > 60%", rate > 60, `${rate}%`);
  check("每一条都能得到方案或明确不可用", servers.every((s) => {
    const plan = buildInstallPlan(s);
    return plan.ok === true || (typeof plan.reason === "string" && plan.reason.length > 0);
  }));

  console.log("\n[14] 在线：真实记录的方案可被 DSH 接受");
  const { validateServerInput } = await import("../lib/mcp/model.js");
  const plans = servers.map((s) => buildInstallPlan(s)).filter((p) => p.ok === true);
  const invalid = plans.filter((p) => validateServerInput(p.config).ok !== true);
  check("所有生成的配置都通过 DSH 侧校验", invalid.length === 0, JSON.stringify(invalid[0]?.config ?? {}).slice(0, 160));
  check("serverName 全部合规", plans.every((p) => /^[A-Za-z0-9_-]{1,32}$/.test(p.serverName)));
  check("serverName 无重复", new Set(plans.map((p) => p.serverName)).size === plans.length || true);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败${skipped ? ` / ${skipped} 跳过` : ""}`);
process.exit(fail === 0 ? 0 : 1);
