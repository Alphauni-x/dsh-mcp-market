/**
 * 包运行器识别 + 冷启动判定测试。
 *
 * 这个模块决定两件会影响用户等待体验的事：
 *   1. 一次探测给多长预算（冷启动要下载依赖，15 秒不够）；
 *   2. 超时后要不要放走子进程（npm 被中途杀死留下的是不会自愈的半成品）。
 *
 * 判定方向必须保守 —— 拿不准就返回 `undefined`（按热启动处理），宁可少给一次
 * 长预算，也不要让所有服务都干等一分钟。所以重点验证「拿不准时不下结论」。
 *
 * 运行：node test/package-runner.test.mjs
 */

import {
  commandBaseName,
  commandPackageOf,
  isColdStart,
  npxCacheHit,
  packageNameOf,
  packageRunnerOf,
  packageSpecOf,
} from "../lib/mcp/package-runner.js";

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

console.log("\n【commandBaseName：裸命令 / 绝对路径 / Windows 扩展名】");

eq("裸命令", commandBaseName("npx"), "npx");
eq("绝对路径", commandBaseName("/opt/homebrew/bin/npx"), "npx");
eq("相对路径", commandBaseName("./node_modules/.bin/uvx"), "uvx");
eq("Windows 扩展名", commandBaseName("C:\\Program Files\\nodejs\\npx.cmd"), "npx");
eq("大小写归一", commandBaseName("NPX"), "npx");
eq("带空格的前后空白", commandBaseName("  npx  "), "npx");
eq("空串", commandBaseName(""), "");
eq("非字符串", commandBaseName(undefined), "");

console.log("\n【packageRunnerOf：哪些命令算包运行器】");

eq("npx", packageRunnerOf("npx")?.id, "npx");
eq("npx 走自带缓存", packageRunnerOf("npx")?.cache, "npm");
eq("uvx", packageRunnerOf("uvx")?.id, "uvx");
eq("uvx 缓存布局不猜", packageRunnerOf("uvx")?.cache, null);
eq("pnpx", packageRunnerOf("pnpx")?.id, "pnpx");
eq("bunx", packageRunnerOf("bunx")?.id, "bunx");
eq("pipx", packageRunnerOf("pipx")?.id, "pipx");
eq("绝对路径也认", packageRunnerOf("/usr/local/bin/npx")?.id, "npx");

check("npm exec 算", packageRunnerOf("npm", ["exec", "-y", "foo"])?.id === "npm");
check("npm x 算", packageRunnerOf("npm", ["x", "foo"])?.id === "npm");
check("npm run 不算", packageRunnerOf("npm", ["run", "build"]) === undefined);
check("pnpm dlx 算", packageRunnerOf("pnpm", ["dlx", "foo"])?.id === "pnpm");
check("pnpm install 不算", packageRunnerOf("pnpm", ["install"]) === undefined);
check("yarn dlx 算", packageRunnerOf("yarn", ["dlx", "foo"])?.id === "yarn");
check("uv tool 算", packageRunnerOf("uv", ["tool", "run", "foo"])?.id === "uv");
check("uv python 不算", packageRunnerOf("uv", ["python", "list"]) === undefined);
check("普通命令不算", packageRunnerOf("python", ["-m", "server"]) === undefined);
check("空命令不算", packageRunnerOf("") === undefined);

console.log("\n【packageNameOf：剥版本后缀】");

eq("裸包名", packageNameOf("12306-mcp"), "12306-mcp");
eq("带版本", packageNameOf("12306-mcp@0.3.10"), "12306-mcp");
eq("scoped 不带版本", packageNameOf("@modelcontextprotocol/server-filesystem"), "@modelcontextprotocol/server-filesystem");
eq("scoped 带版本", packageNameOf("@scope/pkg@1.2.3"), "@scope/pkg");
eq("只有 scope 名", packageNameOf("@scope/pkg"), "@scope/pkg");
eq("空白", packageNameOf("  foo  "), "foo");
eq("空串", packageNameOf(""), "");

console.log("\n【commandPackageOf：从参数里挑包名】");

eq("npx -y 形态", commandPackageOf(["-y", "12306-mcp"]), "12306-mcp");
eq("长选项在前", commandPackageOf(["--yes", "--quiet", "some-mcp", "--port", "1"]), "some-mcp");
eq("scoped", commandPackageOf(["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]), "@modelcontextprotocol/server-filesystem");
eq("--package= 形态", commandPackageOf(["--package=foo-mcp", "foo-mcp"]), "foo-mcp");
eq("-p 形态", commandPackageOf(["-p", "foo-mcp", "foo-mcp"]), "foo-mcp");
eq("带版本", commandPackageOf(["-y", "12306-mcp@0.3.10"]), "12306-mcp");
eq("只有选项", commandPackageOf(["-y", "--quiet"]), "");
eq("空参数", commandPackageOf([]), "");
eq("非数组", commandPackageOf(undefined), "");

console.log("\n【npxCacheHit：扫 _npx 缓存】");

const HOME = "/Users/tester";
const CACHED = "/Users/tester/.npm/_npx/1a2b3c/node_modules/12306-mcp";
const cachedFs = (paths) => (target) => paths.includes(target);

check(
  "缓存目录不存在 → 未命中",
  npxCacheHit("12306-mcp", { home: HOME, exists: () => false }) === false,
);
check(
  "有目录但不含该包 → 未命中",
  npxCacheHit("12306-mcp", {
    home: HOME,
    exists: cachedFs([`${HOME}/.npm/_npx`]),
    readdir: () => ["deadbeef"],
  }) === false,
);
check(
  "命中",
  npxCacheHit("12306-mcp", {
    home: HOME,
    exists: cachedFs([`${HOME}/.npm/_npx`, CACHED, `${HOME}/.npm/_npx`]),
    readdir: () => ["1a2b3c"],
  }) === true,
);
check(
  "多个缓存目录里有一个命中就算命中",
  npxCacheHit("foo-mcp", {
    home: HOME,
    exists: (target) => target === `${HOME}/.npm/_npx` || target === `${HOME}/.npm/_npx/zzz/node_modules/foo-mcp`,
    readdir: () => ["aaa", "zzz"],
  }) === true,
);
check(
  "scoped 包的目录拼接正确",
  npxCacheHit("@scope/pkg", {
    home: HOME,
    exists: (target) => target === `${HOME}/.npm/_npx` || target === `${HOME}/.npm/_npx/h/node_modules/@scope/pkg`,
    readdir: () => ["h"],
  }) === true,
);
check(
  "readdir 抛错 → 判断不了",
  npxCacheHit("foo", {
    home: HOME,
    exists: () => true,
    readdir: () => {
      throw new Error("EACCES");
    },
  }) === undefined,
);
// `home: ""` 不等于「没有 home」：会依次回落到 `$HOME`、`os.homedir()`。
// 桌面版从 launchd 继承环境，HOME 不保证总在 —— 一失手就退回 15 秒预算。
check(
  "显式 home 为空时向下回落，不当成判断不了",
  npxCacheHit("foo", { home: "", exists: () => false }) === false,
);
check("包名像选项 → 判断不了", npxCacheHit("-y", { home: HOME, exists: () => true }) === undefined);
check("空包名 → 判断不了", npxCacheHit("", { home: HOME, exists: () => true }) === undefined);
check(
  "Windows 不猜缓存布局",
  npxCacheHit("foo", { home: HOME, platform: "win32", exists: () => true }) === undefined,
);

console.log("\n【isColdStart：结论只对能精确判定的族下】");

const emptyHome = { home: HOME, exists: () => false };
const hitHome = {
  home: HOME,
  exists: (target) =>
    target === `${HOME}/.npm/_npx` || target === `${HOME}/.npm/_npx/1a2b3c/node_modules/12306-mcp`,
  readdir: () => ["1a2b3c"],
};

check(
  "npx + 缓存空 → 冷",
  isColdStart({ transport: "stdio", command: "npx", args: ["-y", "12306-mcp"] }, emptyHome) === true,
);
check(
  "npx + 缓存命中 → 热",
  isColdStart({ transport: "stdio", command: "npx", args: ["-y", "12306-mcp"] }, hitHome) === false,
);
check(
  "uvx 不下结论",
  isColdStart({ transport: "stdio", command: "uvx", args: ["mcp-server-fetch"] }, emptyHome) === undefined,
);
check(
  "pnpx 不下结论",
  isColdStart({ transport: "stdio", command: "pnpx", args: ["foo"] }, emptyHome) === undefined,
);
check(
  "HTTP 型不下结论",
  isColdStart({ transport: "streamable-http", url: "https://example.com/mcp" }, emptyHome) === undefined,
);
check(
  "没写包名 → 不下结论",
  isColdStart({ transport: "stdio", command: "npx", args: ["-y"] }, emptyHome) === undefined,
);
check("配置非对象 → 不下结论", isColdStart(undefined, emptyHome) === undefined);

console.log("\n【packageSpecOf】");

const spec = packageSpecOf({ transport: "stdio", command: "/usr/local/bin/npx", args: ["-y", "12306-mcp@0.3.10"] });
eq("识别出运行器", spec?.runner.id, "npx");
eq("剥掉版本", spec?.pkg, "12306-mcp");

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exitCode = 1;
