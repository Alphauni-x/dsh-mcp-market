/**
 * 探测失败时的两条恢复路径。
 *
 * 这两条针对的是同一个用户故事：「装了服务，测试连接永远是红的」——
 *
 *   1. **报错要说人话**。`MCP error -32000: Connection closed` 是真因被吞掉后的
 *      残渣：子进程起来了、又立刻崩了，崩溃原因只打在 stderr 上，而传输层默认
 *      把 stderr `inherit` 给宿主，界面完全看不到。改成 pipe 收尾部后，
 *      「模块找不到」「端口被占」这类原因才能落到用户眼前。
 *   2. **别掐断安装**。冷启动（npx 首次要下 200+ 个包）超时后如果直接杀进程，
 *      npm 留下的是空的嵌套 `node_modules` + 记成 `{}` 的 lockfile，永不自愈。
 *      于是用户每点一次「测试连接」就把安装掐断一次，永远装不上。超时后放走
 *      进程、让它把包装完，下次点就命中缓存了。
 *
 * 运行：node test/probe-recovery.test.mjs
 */

import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { probeMcpServer } from "../lib/mcp/probe.js";

let pass = 0;
let fail = 0;

const check = (name, condition, extra) => {
  if (condition) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${extra === undefined ? "" : `  → ${extra}`}`);
  }
};

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "..", "lib", "mcp", "probe.js"), "utf8");

/** 剥掉注释后的源码。「某个写法不在代码里」这类断言必须看它，否则会被注释误伤。 */
const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// ─────────────────── [1] 源码契约 ───────────────────

console.log("\n[1] stderr 收集与超时放手");

check("stdio 传输改用 pipe", /stderr: "pipe"/.test(code));
check("不再沿用默认的 inherit", !/stderr:\s*"inherit"/.test(code));
check("有收集器", /function collectStderr\(transport\)/.test(source));
// SDK 的 stderr 是提前返回的 PassThrough，晚挂就丢掉启动初期（报错最多）的输出。
check(
  "收集在 connect 之前挂上",
  source.indexOf("tail = collectStderr(transport);") < source.indexOf("await raceWithAbort(client.connect"),
);
check("pipe 出来的流有人读", /stream\.on\("data"/.test(source));
check("流错误被吞掉", /stream\.on\("error", \(\) => \{\}\)/.test(source));
check("剥掉 ANSI", /ANSI_RE/.test(source));
check("尾部有字节上限", /STDERR_TAIL_BYTES = \d+/.test(source));
check("只展示末尾几行", /STDERR_TAIL_LINES = \d+/.test(source));

check("冷启动有独立预算", /COLD_START_TIMEOUT_MS = \d+/.test(source));
check("超时后不立即回收", /scheduleLingeringClose\(client, transport\)/.test(source));
check("放手时长有上限", /LINGER_MS = \d+/.test(source));
check("定时器不拖住宿主", /\.unref\(\)/.test(source));
// 只有「确实是冷启动」才该放走进程 —— 服务自己不回应是另一回事，该杀就杀。
check("只在冷启动时放手", /linger = aborted && cold === true/.test(source));
check("非放手路径仍然是后台关闭", /else closeInBackground\(client, transport\);/.test(source));
check("冷启动文案说明在后台继续", /安装已转到后台继续/.test(source));
// 坏缓存只能清掉重装，所以报错里要能把命令递到手上。
check("有坏缓存的恢复提示", /function recoveryHint\(state\)/.test(source));
check("提示里带上可执行的清理命令", /rm -rf "/.test(source));
check("三段信息按顺序拼", /\[reason, stderrTail\(tail\), recoveryHint\(tail\)\]/.test(source));
// 下面两条是既有行为的护栏，别在改这里的时候顺手弄丢。
check("普通超时文案不变", /连接测试超时/.test(source));
check("默认预算仍是 15s", /PROBE_TIMEOUT_MS = 15000/.test(source));

// ─────────────────── [2] stderr 真的被带出来了 ───────────────────

console.log("\n[2] 崩溃原因不再是「Connection closed」");

const blown = await probeMcpServer(
  {
    transport: "stdio",
    command: process.execPath,
    args: [join(here, "fixtures", "crash-with-stderr.mjs")],
  },
  8000,
);

check("探测失败", blown.ok === false, JSON.stringify(blown).slice(0, 160));
check("没有工具", Array.isArray(blown.tools) && blown.tools.length === 0);
check(
  "带出 stderr 第一行",
  typeof blown.error === "string" && blown.error.includes("cannot find module"),
  blown.error,
);
check(
  "带出 stderr 第二行（非 ASCII 也没丢）",
  typeof blown.error === "string" && blown.error.includes("模块解析失败"),
  blown.error,
);
check("有「子进程输出」的抬头", typeof blown.error === "string" && blown.error.includes("子进程输出："));
check("ANSI 颜色码被剥掉", typeof blown.error === "string" && !blown.error.includes("\u001B"));
check(
  "原始错误也还在（信息不丢）",
  typeof blown.error === "string" && /Connection closed|MCP error|-32000/.test(blown.error),
  blown.error,
);

// ─────────────────── [3] 坏掉的包缓存要能自己诊断 ───────────────────

console.log("\n[3] 坏缓存：认出「空壳目录」并给出恢复命令");

const brokenCache = await probeMcpServer(
  {
    transport: "stdio",
    command: process.execPath,
    args: [join(here, "fixtures", "broken-npx-cache.mjs")],
  },
  8000,
);
const brokenError = String(brokenCache.error ?? "");

check("探测失败", brokenCache.ok === false);
check("指出是缓存不完整", brokenError.includes("缓存不完整"), brokenError);
check("说明 npx 不会自愈", brokenError.includes("npx 不会自动修复"));
check(
  "递上可执行的清理命令",
  brokenError.includes('rm -rf "/Users/tester/.npm/_npx/a1b2c3d4e5f60718"'),
  brokenError,
);
check("路径没有多余的前导斜杠", !brokenError.includes('rm -rf "//'));
check("告诉用户装完再回来", brokenError.includes("等它装完"));
check("原始堆栈也一并保留", brokenError.includes("ERR_MODULE_NOT_FOUND"));
check(
  "建议排在子进程输出之后",
  brokenError.indexOf("缓存不完整") > brokenError.indexOf("子进程输出："),
);

// 不相干的失败不该硬套这个建议。
const unrelated = await probeMcpServer(
  { transport: "stdio", command: "definitely-not-a-real-command-for-this-test", args: [] },
  4000,
);
check(
  "命令不存在时不给缓存建议",
  typeof unrelated.error === "string" && !unrelated.error.includes("缓存不完整"),
  unrelated.error,
);

// ─────────────────── [4] 冷启动超时不掐断安装 ───────────────────

console.log("\n[4] 冷启动超时后进程被放走");

if (process.platform === "win32") {
  console.log("  （Windows 上跳过：夹具是 POSIX shell 脚本）");
} else {
  const dir = mkdtempSync(join(tmpdir(), "dsh-probe-linger-"));
  const marker = join(dir, "finished.txt");
  // 命令的 basename 必须是 npx —— 识别成包运行器才会走冷启动分支。
  const runner = join(dir, "npx");
  writeFileSync(
    runner,
    `#!/bin/sh\necho "downloading dependencies…" >&2\nsleep 3\necho done > "${marker}"\n`,
  );
  chmodSync(runner, 0o755);

  const started = Date.now();
  const cold = await probeMcpServer(
    { transport: "stdio", command: runner, args: ["-y", "some-mcp"], env: {} },
    // 显式给一个非默认预算：冷启动放大只对默认值生效，这样测试才等得起。
    700,
    // 空缓存目录 → 判定为冷启动。
    { home: join(dir, "empty-home"), exists: () => false },
  );
  const elapsed = Date.now() - started;

  check("冷启动超时返回失败", cold.ok === false);
  check(`超时按传入的预算生效（实测 ${elapsed}ms）`, elapsed >= 650 && elapsed < 2500, `${elapsed}ms`);
  check(
    "文案说清是首次下载、已转后台",
    typeof cold.error === "string" && cold.error.includes("首次运行需要下载依赖") && cold.error.includes("后台继续"),
    cold.error,
  );
  check(
    "超时也能看到下载进度",
    typeof cold.error === "string" && cold.error.includes("downloading dependencies"),
    cold.error,
  );

  // 关键断言：进程还活着。它 sleep 3 秒后自己写标记文件 —— 被杀了就不会出现。
  await new Promise((resolve) => setTimeout(resolve, 4000));
  check("子进程没被杀死，把活干完了", existsSync(marker), marker);
  check("标记文件内容正确", existsSync(marker) && readFileSync(marker, "utf8").trim() === "done");

  rmSync(dir, { recursive: true, force: true });
}

// ─────────────────── [5] 热启动该杀还是要杀 ───────────────────

console.log("\n[5] 非冷启动超时仍然回收进程");

if (process.platform === "win32") {
  console.log("  （Windows 上跳过）");
} else {
  const dir = mkdtempSync(join(tmpdir(), "dsh-probe-kill-"));
  const marker = join(dir, "should-not-exist.txt");
  // basename 是 python 而不是包运行器 → 判不出冷启动 → 超时后照常回收。
  const runner = join(dir, "python");
  writeFileSync(runner, `#!/bin/sh\nsleep 3\necho survived > "${marker}"\n`);
  chmodSync(runner, 0o755);

  const killed = await probeMcpServer(
    { transport: "stdio", command: runner, args: ["-m", "server"], env: {} },
    700,
  );

  check("超时返回失败", killed.ok === false);
  check(
    "文案不带「首次下载」的误导",
    typeof killed.error === "string" && !killed.error.includes("首次运行需要下载依赖"),
    killed.error,
  );

  await new Promise((resolve) => setTimeout(resolve, 4000));
  check("进程被回收，活没干完", !existsSync(marker), "进程居然活到了最后");

  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exitCode = 1;
