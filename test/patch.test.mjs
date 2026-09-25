/**
 * patch 读写与共存安全性测试。
 *
 * 这是全项目最危险的部分 —— 它直接改写用户的 DSH 配置文件，
 * 写坏会导致 DSH 起不来。因此重点验证：
 *   1. 各种模板形态下都能产出合法 YAML；
 *   2. 受管块之外的字节逐字不变（含其它插件的受管块）。
 *
 * 运行：node test/patch.test.mjs
 */

import { parse } from "yaml";
import {
  MARKET_BLOCK_BEGIN,
  MARKET_BLOCK_END,
  extractManagedRows,
  listMcpPatchRows,
  replaceManagedBlock,
  rowIdForServerName,
  serverNameFromRowId,
  validatePatchText,
} from "../lib/mcp/patch-editor.js";
import { configFromCustomInput, patchRowToView, toPatchRow, validateServerInput } from "../lib/mcp/model.js";

let pass = 0;
let fail = 0;

const check = (name, condition, extra) => {
  if (condition) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${extra ? `  → ${extra}` : ""}`);
  }
};

const mkRow = (name) =>
  toPatchRow({
    serverName: name,
    transport: "stdio",
    command: "npx",
    args: ["-y", `${name}-pkg`],
    env: {},
    cwd: "",
    toolCallTimeoutMs: 60000,
    failOnStartupError: false,
    reconnect: { enabled: true, initialDelayMs: 500, maxDelayMs: 30000, maxAttempts: 10 },
  });

console.log("\n[1] 空模板 [] 上追加");
const template = "# profile root\n# comment\n[]\n";
const a1 = replaceManagedBlock(template, [mkRow("fetch")]);
validatePatchText(a1);
check("仍是合法顶层数组", true);
check("包含受管块标记", a1.includes(MARKET_BLOCK_BEGIN) && a1.includes(MARKET_BLOCK_END));
check("注释被保留", a1.includes("# profile root"));
check("[] 已被消费掉", !a1.includes("[]"));
check("可被重新解析出 1 行", extractManagedRows(a1).length === 1);

console.log("\n[2] 已有内容上追加");
const existing = '- id: ui-theme\n  name: "@deepseek-ai/dsh-client-ui-theme"\n  config:\n    preference: system\n';
const a2 = replaceManagedBlock(existing, [mkRow("a"), mkRow("b")]);
validatePatchText(a2);
check("原有行原样保留", a2.includes("preference: system"));
check("解析出 2 行", extractManagedRows(a2).length === 2);
const js2 = parse(a2);
check("顶层仍是数组且变长", Array.isArray(js2) && js2.length === 2);

console.log("\n[3] 删除全部受管行");
const a3 = replaceManagedBlock(a2, []);
check("受管块被清除", !a3.includes(MARKET_BLOCK_BEGIN));
check("原内容保留", a3.includes("preference: system"));
check("仍是合法数组", Array.isArray(parse(a3)));

console.log("\n[4] 只剩注释时删除全部受管行 → 补回 []");
const onlyBlock = replaceManagedBlock("# just a comment\n[]\n", [mkRow("x")]);
const a4 = replaceManagedBlock(onlyBlock, []);
const js4 = parse(a4);
check("补回合法空数组", Array.isArray(js4) && js4.length === 0, JSON.stringify(a4));

console.log("\n[5] 与 dsh-skill-mcp-panel 的受管块共存（关键）");
const coexisting = [
  "- id: ui-settings-general",
  '  name: "@deepseek-ai/dsh-client-ui-settings-general"',
  "  config:",
  "    welcomeNoticeVersion: 2026-08-13.1",
  "",
  "# >>> dsh-skill-mcp-panel:mcp:begin",
  "- insert:",
  "    - id: panel-mcp-foo",
  '      name: "@deepseek-ai/dsh-mcp-client"',
  "      config:",
  "        serverName: foo",
  "        transport: stdio",
  "        command: uvx",
  "# <<< dsh-skill-mcp-panel:mcp:end",
  "",
].join("\n");

const panelBegin = "# >>> dsh-skill-mcp-panel:mcp:begin";
const panelEnd = "# <<< dsh-skill-mcp-panel:mcp:end";
const slicePanel = (text) => text.slice(text.indexOf(panelBegin), text.indexOf(panelEnd) + panelEnd.length);
const panelBlockBefore = slicePanel(coexisting);

const a5 = replaceManagedBlock(coexisting, [mkRow("bar")]);
check("panel 块逐字未变", a5.includes(panelBlockBefore));
check("我方块已写入", a5.includes(MARKET_BLOCK_BEGIN) && a5.includes("mcp-market-bar"));
check("我方只解析到自己的 1 行", extractManagedRows(a5).length === 1);
check("全文件能看到 2 个 MCP 行", listMcpPatchRows(a5).length === 2);
check("panel 块前后完全一致", panelBlockBefore === slicePanel(a5));

console.log("\n[6] 我方块被二次替换（增删改）");
const a6 = replaceManagedBlock(a5, [mkRow("bar"), mkRow("baz")]);
check("变 2 行", extractManagedRows(a6).length === 2);
check("panel 块仍完好", a6.includes(panelBlockBefore));
const a7 = replaceManagedBlock(a6, [mkRow("baz")]);
check(
  "删到 1 行",
  extractManagedRows(a7).length === 1 && extractManagedRows(a7)[0].config.serverName === "baz",
);
check("panel 块仍完好(2)", a7.includes(panelBlockBefore));

console.log("\n[7] 标记不成对时报错");
let threw = false;
try {
  extractManagedRows(`${MARKET_BLOCK_BEGIN}\n- insert: []\n`);
} catch {
  threw = true;
}
check("begin 无 end 时抛错", threw);

console.log("\n[8] 行 id 与 serverName 互转");
check("serverName → 行 id", rowIdForServerName("fetch") === "mcp-market-fetch");
check("行 id → serverName", serverNameFromRowId("mcp-market-fetch") === "fetch");
check("他人受管行不被认领", serverNameFromRowId("panel-mcp-foo") === undefined);

console.log("\n[9] 输入校验");
check("合法 stdio", validateServerInput({ serverName: "ok-1", transport: "stdio", command: "npx" }).ok);
check("非法 serverName", !validateServerInput({ serverName: "含中文", transport: "stdio", command: "npx" }).ok);
check("stdio 缺命令", !validateServerInput({ serverName: "ok", transport: "stdio", command: "  " }).ok);
check("http 缺地址", !validateServerInput({ serverName: "ok", transport: "streamable-http", url: "" }).ok);
check("http 非法协议", !validateServerInput({ serverName: "ok", transport: "streamable-http", url: "ftp://x.com" }).ok);
check("http 合法", validateServerInput({ serverName: "ok", transport: "streamable-http", url: "https://x.com/mcp" }).ok);

console.log("\n[10] 行 → 视图");
const view = patchRowToView(mkRow("demo"), { fiberPhase: "active", toolCount: 3 });
check("serverName 正确", view.serverName === "demo");
check("transport 正确", view.transport === "stdio");
check("enabled 默认 true", view.enabled === true);
check("工具数透传", view.toolCount === 3);
const viewOff = patchRowToView({ ...mkRow("off"), disabled: true }, {});
check("disabled 行 enabled=false", viewOff.enabled === false);

console.log("\n[11] 手动添加：表单输入整形");
const customStdio = configFromCustomInput({
  serverName: "  my-server  ",
  transport: "stdio",
  command: " npx ",
  args: ["-y", "  ", "@scope/pkg"],
  cwd: "   ",
  url: "https://should-be-ignored.example.com",
  env: { API_KEY: " k ", EMPTY: "", "  ": "x" },
});
check("serverName 去空白", customStdio.serverName === "my-server");
check("command 去空白", customStdio.command === "npx");
check("args 丢掉空白项", customStdio.args.length === 2 && customStdio.args[1] === "@scope/pkg");
check("空白 cwd 不写入", customStdio.cwd === undefined);
check("stdio 不混入 url", customStdio.url === undefined);
check("env 空键空值被丢弃", Object.keys(customStdio.env).length === 1 && customStdio.env.API_KEY === "k");
check("整形结果能过校验(stdio)", validateServerInput(customStdio).ok);

const customHttp = configFromCustomInput({
  serverName: "remote-1",
  transport: "streamable-http",
  url: " https://example.com/mcp ",
  command: "npx",
  args: ["-y", "pkg"],
  headers: { Authorization: "Bearer x", "": "drop" },
});
check("url 去空白", customHttp.url === "https://example.com/mcp");
check("http 不混入 command/args", customHttp.command === undefined && customHttp.args === undefined);
check("headers 保留且去掉空键", customHttp.headers.Authorization === "Bearer x" && Object.keys(customHttp.headers).length === 1);
check("没有 env 时不写空对象", customHttp.env === undefined);
check("整形结果能过校验(http)", validateServerInput(customHttp).ok);

// 两种 transport 的字段是互斥的：官方 StreamableHttpConfig 里没有 env，
// 塞进去不会报错、但会被 schema 静默丢掉 —— 属于「填了等于没填」，必须拦住。
const customHttpWithEnv = configFromCustomInput({
  serverName: "remote-2",
  transport: "streamable-http",
  url: "https://example.com/mcp",
  env: { SHOULD_NOT_SURVIVE: "x" },
  headers: { Authorization: "Bearer test-token-123" },
});
check("http 分支不写 env", customHttpWithEnv.env === undefined);
check("http 分支认 env 之外的 headers", customHttpWithEnv.headers.Authorization === "Bearer test-token-123");
check(
  "header 值只去首尾空白、保留内部空格",
  configFromCustomInput({
    serverName: "remote-3",
    transport: "streamable-http",
    url: "https://example.com/mcp",
    headers: { Authorization: "  Bearer a b c  " },
  }).headers.Authorization === "Bearer a b c",
);

const customStdioWithHeaders = configFromCustomInput({
  serverName: "local-1",
  transport: "stdio",
  command: "node",
  headers: { SHOULD_NOT_SURVIVE: "x" },
});
check("stdio 分支不写 headers", customStdioWithHeaders.headers === undefined);

const httpRow = toPatchRow(customHttpWithEnv, true);
check(
  "headers 能落到 patch 行的 config 上",
  httpRow.config.headers.Authorization === "Bearer test-token-123" &&
    patchRowToView(httpRow, {}).headerKeys.join() === "Authorization",
);

// 空表单必须被拦住，否则会把一行没有 command 的配置写进用户的 patch 文件。
check("空表单整形后仍不合法", !validateServerInput(configFromCustomInput({})).ok);
check("乱输入不抛异常", typeof configFromCustomInput(undefined) === "object" && !validateServerInput(configFromCustomInput(null)).ok);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
