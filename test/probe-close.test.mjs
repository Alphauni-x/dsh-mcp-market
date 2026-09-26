/**
 * 连接探测的两件事：
 *
 *   1. **关闭动作不参与返回路径**。一次 stdio 探测的 close 要等约 70ms（等子进程
 *      退干净），让用户为进程回收买单没有道理。改成后台关闭后，速度提升的同时
 *      必须保证：关闭失败不能抛进调用栈，也不能变成 unhandledRejection。
 *   2. **失败要快且能照着做**。命令不存在是毫秒级返回的，不该卡满超时；
 *      而且报错必须说清是「没装」还是「装了但不在 PATH 上」。
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { probeMcpServer } from "../lib/mcp/probe.js";

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

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "..", "lib", "mcp", "probe.js"), "utf8");

// ─────────────────── [1] 关闭动作：源码契约 ───────────────────

console.log("\n[1] 关闭动作不阻塞返回");
check("存在后台关闭函数", /function closeInBackground\(client, transport\)/.test(source));
check("finally 里调用它", /closeInBackground\(client, transport\);/.test(source));
// 这条是本次改动的核心：过去是 `await Promise.allSettled([...])`，返回值要等进程退干净。
check("不再 await 关闭", !/await Promise\.allSettled\(/.test(source));
check("关闭是 fire-and-forget", /void Promise\.allSettled\(/.test(source));
check("client.close 带 catch", /client\.close\(\)\.catch\(\(\) => \{\}\)/.test(source));
// transport 可能是 undefined，也可能是同步抛；两头都要兜住。
check("transport.close 走 Promise.resolve 包一层", /Promise\.resolve\(transport\?\.close\?\.\(\)\)\.catch\(\(\) => \{\}\)/.test(source));
check("同步抛出也被吞掉", /}\s*catch\s*\{\s*\n\s*\/\/ 同步抛出/.test(source));
check("超时定时器仍然清理", /clearTimeout\(timer\);/.test(source));

// ─────────────────── [2] 关闭动作：真实行为 ───────────────────

console.log("\n[2] 关闭不产生未处理拒绝");
const unhandled = [];
const onUnhandled = (reason) => unhandled.push(reason);
process.on("unhandledRejection", onUnhandled);

const started = Date.now();
const gone = await probeMcpServer(
  { transport: "stdio", command: "definitely-not-a-real-command-for-this-test", args: [] },
  5000,
);
const elapsed = Date.now() - started;

check("命令不存在 → ok:false", gone.ok === false);
check("工具列表为空数组", Array.isArray(gone.tools) && gone.tools.length === 0);
// 失败必须是即时的：spawn 的 ENOENT 是同步返回的，等到超时说明把错误吞了。
check(`毫秒级失败（实测 ${elapsed}ms）`, elapsed < 1500);
check(
  "报错说清是「不在 PATH 上」",
  typeof gone.error === "string" && gone.error.includes("不在宿主进程的 PATH 中"),
  gone.error,
);
check("报错里带上原始命令名", typeof gone.error === "string" && gone.error.includes("definitely-not-a-real-command"));

await new Promise((resolve) => setTimeout(resolve, 150));
process.off("unhandledRejection", onUnhandled);
check("后台关闭没有抛出未处理拒绝", unhandled.length === 0, unhandled.map(String).join(" | "));

// ─────────────────── [3] 既有行为不回归 ───────────────────

console.log("\n[3] 既有行为不回归");
check("总超时仍是 15s", /PROBE_TIMEOUT_MS = 15000/.test(source));
check("超时会给出可读文案", /连接测试超时/.test(source));
check("取消用 AbortController", /new AbortController\(\)/.test(source));
check("stdio 与 http 两种传输都还在", /StdioClientTransport/.test(source) && /StreamableHTTPClientTransport/.test(source));
check("env 以配置覆盖宿主", /\{ \.\.\.scrubbedEnv\(\), \.\.\.stringMap\(config\.env\) \}/.test(source));
check("只透传必要环境变量", /const keep = \["PATH", "HOME", "SHELL"/.test(source));
check("工具分页仍然处理", /page\.nextCursor/.test(source));

// ─────────────────── 汇总 ───────────────────

console.log(`\n结果：${pass} 通过 / ${failures.length} 失败`);
if (failures.length > 0) {
  console.log(`失败项：${failures.join("、")}`);
  process.exitCode = 1;
}
