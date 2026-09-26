/**
 * 宿主 PATH 修复测试。
 *
 * 这个模块的行为会落到宿主进程的全局环境变量上（`process.env.PATH`），
 * 一旦误判就可能影响宿主里所有其它功能，所以重点验证：
 *   1. 只在**确实需要**时才动手（已经正常的环境一个字节都不改）；
 *   2. 只 prepend，原有条目一个不丢；
 *   3. 幂等（重复加载不会让 PATH 越滚越长）；
 *   4. 开关与不支持平台下彻底不动；
 *   5. 登录 shell 探测的所有失败路径都静默降级。
 *
 * 除了最后一节，全程注入假的 exists / isExecutable / spawnSync，
 * 不依赖本机真实的目录布局。
 *
 * 运行：node test/host-path.test.mjs
 */

import { existsSync } from "node:fs";
import {
  candidateDirs,
  currentPath,
  dedupeDirs,
  diagnoseCommand,
  ensureHostPath,
  isPathLikeCommand,
  joinPath,
  normalizePathFix,
  planPathFix,
  probeLoginShellPath,
  resolveLoginShell,
  resolveOnPath,
  splitPath,
} from "../lib/mcp/host-path.js";

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

const eq = (name, actual, expected) =>
  check(name, actual === expected, `得到 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}`);

const HOME = "/Users/tester";
const SYSTEM_ONLY = "/usr/bin:/bin:/usr/sbin:/sbin";

/** 假文件系统：只有列出的路径存在。 */
const fsWith = (...paths) => (dir) => paths.includes(dir);

/** 假的可执行判断：只有列出的路径可执行。 */
const execWith = (...paths) => (file) => paths.includes(file);

console.log("\n【splitPath / joinPath / dedupeDirs】");
check("POSIX 按冒号切分", splitPath("/a:/b:/c", "linux").join("|") === "/a|/b|/c");
check("Windows 按分号切分", splitPath("C:\\a;D:\\b", "win32").join("|") === "C:\\a|D:\\b");
check("丢弃空段（含结尾分隔符）", splitPath("/a::/b:", "linux").join("|") === "/a|/b");
check("空输入得空数组", splitPath(undefined, "linux").length === 0 && splitPath("", "linux").length === 0);
eq("POSIX 拼接", joinPath(["/a", "/b"], "linux"), "/a:/b");
eq("Windows 拼接", joinPath(["C:\\a", "D:\\b"], "win32"), "C:\\a;D:\\b");
check("去重保留首次出现顺序", dedupeDirs(["/b", "/a", "/b", "", null, "/a"]).join("|") === "/b|/a");

console.log("\n【candidateDirs】");
{
  const dirs = candidateDirs({ home: HOME, platform: "linux" });
  check("含用户的 ~/.local/bin", dirs.includes("/Users/tester/.local/bin"));
  check("含 Homebrew", dirs.includes("/opt/homebrew/bin"));
  check("含 MacPorts", dirs.includes("/opt/local/bin"));
  check("不含应用自带的 runtime 目录（那儿没有 npx）", dirs.every((dir) => !dir.includes("DeepSeek Harness.app")));
  check("Windows 下不产出候选目录", candidateDirs({ home: HOME, platform: "win32" }).length === 0);
  check("home 为空时只给绝对路径", candidateDirs({ home: "", platform: "linux" }).every((dir) => dir.startsWith("/")));
}

console.log("\n【isPathLikeCommand】");
check("裸命令名不是路径形态", isPathLikeCommand("uvx", "linux") === false);
check("绝对路径是路径形态", isPathLikeCommand("/opt/homebrew/bin/npx", "linux") === true);
check("相对路径（含分隔符）也是路径形态", isPathLikeCommand("./start.sh", "linux") === true);
check("去掉空白后再判断", isPathLikeCommand("  uvx  ", "linux") === false);
check("空字符串不是路径形态", isPathLikeCommand("", "linux") === false);
check("Windows 盘符路径", isPathLikeCommand("C:\\tools\\npx.cmd", "win32") === true);

console.log("\n【resolveOnPath】");
{
  const isExecutable = execWith("/Users/tester/.local/bin/uvx", "/usr/bin/env");
  const path = "/Users/tester/.local/bin:/usr/bin:/bin";
  eq(
    "在 PATH 上找到命令",
    resolveOnPath("uvx", path, { platform: "linux", isExecutable }),
    "/Users/tester/.local/bin/uvx",
  );
  eq("不在 PATH 上则返回 undefined", resolveOnPath("npx", path, { platform: "linux", isExecutable }), undefined);
  eq("空命令返回 undefined", resolveOnPath("", path, { platform: "linux", isExecutable }), undefined);
  eq(
    "路径形态的命令原样交还（PATH 不是问题所在）",
    resolveOnPath("/opt/homebrew/bin/npx", path, { platform: "linux", isExecutable }),
    "/opt/homebrew/bin/npx",
  );
  eq(
    "目录条目末尾多一个斜杠也能找",
    resolveOnPath("uvx", "/Users/tester/.local/bin/:/usr/bin", { platform: "linux", isExecutable }),
    "/Users/tester/.local/bin/uvx",
  );
  eq("靠后的目录也能被找到", resolveOnPath("env", path, { platform: "linux", isExecutable }), "/usr/bin/env");
}

console.log("\n【diagnoseCommand：把 ENOENT 翻译成能照着做的提示】");
{
  const isExecutable = execWith("/Users/tester/.local/bin/uvx");
  const missing = diagnoseCommand("uvx", SYSTEM_ONLY, { platform: "linux", isExecutable });
  check("不在 PATH 上时给出命令名", typeof missing === "string" && missing.includes('"uvx"'));
  check("提示里点明是 PATH 问题", typeof missing === "string" && missing.includes("PATH"));
  check(
    "命令能被解析时不给提示",
    diagnoseCommand("uvx", `/Users/tester/.local/bin:${SYSTEM_ONLY}`, { platform: "linux", isExecutable }) === undefined,
  );
  const absolute = diagnoseCommand("/opt/missing/npx", SYSTEM_ONLY, { platform: "linux", isExecutable });
  check("绝对路径不存在时给出文件级提示", typeof absolute === "string" && absolute.includes("/opt/missing/npx"));
  check("绝对路径不存在时不说成 PATH 问题", typeof absolute === "string" && !absolute.includes("PATH"));
  check(
    "绝对路径存在时不提示",
    diagnoseCommand("/Users/tester/.local/bin/uvx", SYSTEM_ONLY, { platform: "linux", isExecutable }) === undefined,
  );
  check("空命令不提示", diagnoseCommand("", SYSTEM_ONLY, { platform: "linux", isExecutable }) === undefined);
}

console.log("\n【planPathFix：桌面版场景（宿主只拿到四个系统目录）】");
{
  const exists = fsWith("/Users/tester/.local/bin", "/opt/homebrew/bin", "/opt/local/bin");
  const plan = planPathFix({ current: SYSTEM_ONLY, home: HOME, platform: "linux", exists });

  check("补上了 ~/.local/bin", plan.add.includes("/Users/tester/.local/bin"));
  check("补上了 /opt/homebrew/bin", plan.add.includes("/opt/homebrew/bin"));
  check("不补不存在的目录", !plan.add.includes("/usr/local/bin") && !plan.add.includes("/Users/tester/.bun/bin"));
  check(
    "原有四个系统目录一个不丢",
    ["/usr/bin", "/bin", "/usr/sbin", "/sbin"].every((dir) => splitPath(plan.after, "linux").includes(dir)),
  );
  check(
    "补进去的目录排在原有目录之前",
    plan.after.indexOf("/Users/tester/.local/bin") === 0 &&
      plan.after.indexOf("/Users/tester/.local/bin") < plan.after.indexOf("/usr/bin"),
  );
  eq("after 是合法 PATH 串", joinPath(splitPath(plan.after, "linux"), "linux"), plan.after);

  const again = planPathFix({ current: plan.after, home: HOME, platform: "linux", exists });
  check("再算一次没有要补的（幂等）", again.add.length === 0);
  eq("再算一次 after 与 current 逐字相同", again.after, plan.after);

  // 环境已完整：候选里**所有存在的目录**都已在 PATH 上（夹具用到的三个都存在）。
  const clean = "/Users/tester/.local/bin:/opt/homebrew/bin:/opt/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
  const noop = planPathFix({ current: clean, home: HOME, platform: "linux", exists });
  check("环境已完整时不动作", noop.add.length === 0);
  eq("环境已完整时连归一化都不做（一个字节不改）", noop.after, clean);
}

console.log("\n【planPathFix：登录 shell 的 PATH 作为补充来源】");
{
  const exists = fsWith("/Users/tester/.nvm/versions/node/v24.20.0/bin", "/usr/local/bin");
  const plan = planPathFix({
    current: SYSTEM_ONLY,
    home: HOME,
    platform: "linux",
    exists,
    candidates: ["/usr/local/bin"],
    loginShellPath: `/Users/tester/.nvm/versions/node/v24.20.0/bin:/usr/local/bin:${SYSTEM_ONLY}`,
  });
  check("从登录 shell 的 PATH 里补到了 nvm 目录", plan.add.includes("/Users/tester/.nvm/versions/node/v24.20.0/bin"));
  check("已经有的目录不会重复补", plan.add.filter((dir) => dir === "/usr/local/bin").length === 1);
  check("原始 PATH 里的条目不算「要补的」", !plan.add.includes("/usr/bin") && !plan.add.includes("/bin"));
  check(
    "去重后最终串里没有重复目录",
    splitPath(plan.after, "linux").length === new Set(splitPath(plan.after, "linux")).size,
  );
}

console.log("\n【ensureHostPath：真正写 process.env.PATH】");
{
  const exists = fsWith("/Users/tester/.local/bin", "/opt/homebrew/bin");
  const env = { PATH: SYSTEM_ONLY, HOME: HOME };
  const report = ensureHostPath({ env, home: HOME, platform: "linux", exists, loginShellPath: "" });

  check("报告 changed", report.changed === true);
  check("报告里没有 skip 原因", report.skipped === "");
  eq("报告 added 与预期一致", report.added.join("|"), "/Users/tester/.local/bin|/opt/homebrew/bin");
  check("env.PATH 真的被改写了", env.PATH.startsWith("/Users/tester/.local/bin:"));
  eq("报告 before 是改动前的值", report.before, SYSTEM_ONLY);
  eq("报告 after 与 env.PATH 一致", report.after, env.PATH);

  const second = ensureHostPath({ env, home: HOME, platform: "linux", exists, loginShellPath: "" });
  check("第二次调用不再改动", second.changed === false && second.skipped === "nothing-to-add");
  eq("第二次调用后 PATH 不变", env.PATH, report.after);
}
{
  const exists = fsWith("/Users/tester/.local/bin");
  const env = { PATH: SYSTEM_ONLY, HOME: HOME };
  const report = ensureHostPath({ env, home: HOME, platform: "linux", exists, enabled: false });
  check("开关关闭时跳过", report.changed === false && report.skipped === "disabled");
  eq("开关关闭时 env.PATH 原样", env.PATH, SYSTEM_ONLY);
}
{
  const env = { PATH: "C:\\Windows\\System32" };
  const report = ensureHostPath({ env, platform: "win32", exists: () => true });
  check("Windows 下跳过", report.changed === false && report.skipped === "unsupported-platform");
  eq("Windows 下 env.PATH 原样", env.PATH, "C:\\Windows\\System32");
}
{
  const env = { PATH: "/a:/b" };
  const report = ensureHostPath({ env, platform: "linux", exists: () => false });
  check("没有目录存在时不动作", report.changed === false && report.skipped === "nothing-to-add");
  eq("没有目录存在时 env.PATH 原样", env.PATH, "/a:/b");
}

console.log("\n【currentPath】");
check("POSIX 取 PATH", currentPath({ PATH: "/a:/b" }, "linux") === "/a:/b");
check("Windows 回退到 Path", currentPath({ Path: "C:\\a", PATH: "SHOULD_LOSE" }, "win32") === "C:\\a");
check("缺键时得空串", currentPath({}, "linux") === "");

console.log("\n【probeLoginShellPath：所有失败路径都必须静默降级】");
{
  const shell = "/bin/zsh";
  const okRun = () => ({ status: 0, stdout: `/Users/tester/.local/bin:${SYSTEM_ONLY}`, error: undefined });
  const call = (run, extra = {}) =>
    probeLoginShellPath({ platform: "linux", shell, spawnSync: run, env: { SHELL: shell }, ...extra });

  eq("正常取得 PATH", call(okRun), `/Users/tester/.local/bin:${SYSTEM_ONLY}`);
  eq("退出码非 0 → 空串", call(() => ({ status: 1, stdout: "/a:/b" })), "");
  eq("spawn 报错 → 空串", call(() => ({ status: 0, stdout: "/a:/b", error: new Error("ENOENT") })), "");
  eq("有横幅杂音（含换行）→ 空串", call(() => ({ status: 0, stdout: "welcome\n/a:/b" })), "");
  eq("输出为空 → 空串", call(() => ({ status: 0, stdout: "   " })), "");
  eq("输出不像 PATH → 空串", call(() => ({ status: 0, stdout: "not-a-path" })), "");
  eq("返回 null → 空串", call(() => null), "");
  eq(
    "抛异常 → 空串",
    call(() => {
      throw new Error("boom");
    }),
    "",
  );
  eq(
    "指定的 shell 不存在时回落到可用的默认 shell（仍能取得 PATH）",
    call(() => ({ status: 0, stdout: "/a:/b" }), { shell: "/nonexistent/shell" }),
    "/a:/b",
  );
  eq(
    "shell 为空时同样回落（宿主不保证有 $SHELL）",
    call(() => ({ status: 0, stdout: "/a:/b" }), { shell: "" }),
    "/a:/b",
  );
  eq("Windows → 空串", probeLoginShellPath({ platform: "win32", shell, spawnSync: okRun }), "");
}

console.log("\n【resolveLoginShell：$SHELL 缺失也要能用】");
{
  eq("显式指定且存在 → 用它", resolveLoginShell("/bin/zsh", (p) => p === "/bin/zsh"), "/bin/zsh");
  eq(
    "显式指定但不存在 → 按 zsh/bash/sh 顺序回落",
    resolveLoginShell("/nope", (p) => p === "/bin/bash"),
    "/bin/bash",
  );
  eq(
    "一个都没有 → 空串（调用方退回静态候选目录）",
    resolveLoginShell("/nope", () => false),
    "",
  );
  eq(
    "不给值时只用默认表，不被 $SHELL 干扰",
    resolveLoginShell("", (p) => p === "/bin/sh"),
    "/bin/sh",
  );
  check("默认调用不抛异常", typeof resolveLoginShell() === "string");
}
{
  let argv;
  const recording = (file, args) => {
    argv = args;
    return { status: 0, stdout: "/a:/b" };
  };
  probeLoginShellPath({ platform: "linux", shell: "/bin/zsh", spawnSync: recording });
  check("传的是 -lc 而不是 -ilc（避免 source .zshrc 的副作用）", Array.isArray(argv) && argv[0] === "-lc");
  check("只跑一条 printf，不执行别的东西", argv.length === 2 && argv[1].startsWith("printf"));
}

console.log("\n【normalizePathFix】");
{
  check("默认全开", normalizePathFix(undefined).fixHostPath === true);
  check("默认探测登录 shell", normalizePathFix({}).probeLoginShell === true);
  check("显式关闭 fixHostPath", normalizePathFix({ fixHostPath: false }).fixHostPath === false);
  check("显式关闭 probeLoginShell", normalizePathFix({ probeLoginShell: false }).probeLoginShell === false);
  check("非布尔值不算打开", normalizePathFix({ fixHostPath: "yes" }).fixHostPath === false);
  check("null / 数组等乱输入不抛", normalizePathFix(null).fixHostPath === true && normalizePathFix([]).fixHostPath === true);
}

console.log("\n【真实文件系统冒烟（用本机真实目录，模拟桌面版处境）】");
{
  const home = process.env.HOME ?? "";
  const realLocal = `${home}/.local/bin`;
  const env = { PATH: SYSTEM_ONLY, HOME: home };
  const report = ensureHostPath({ env, platform: process.platform, loginShellPath: "" });

  check(
    "把 ~/.local/bin 补进了 PATH（本机确实有该目录）",
    existsSync(realLocal) ? report.added.includes(realLocal) : true,
    JSON.stringify(report.added),
  );
  check(
    "补完之后原有四个系统目录依然完整",
    ["/usr/bin", "/bin", "/usr/sbin", "/sbin"].every((dir) => splitPath(report.after, "linux").includes(dir)),
  );
  check(
    "补完之后 uvx 能被解析出来",
    existsSync(realLocal)
      ? resolveOnPath("uvx", report.after, { platform: process.platform }) !== undefined
      : true,
    `PATH=${report.after}`,
  );
  check("真实登录 shell 探测不抛异常且形状正确", typeof probeLoginShellPath() === "string");
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
