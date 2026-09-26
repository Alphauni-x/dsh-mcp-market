/**
 * 包运行器识别 + 冷启动判定。
 *
 * 背景：`npx -y <pkg>` 这类 stdio 配置，第一次运行要先把包下载、解包到
 * `~/.npm/_npx/<hash>/`。实测一个带 200+ 依赖的包（`12306-mcp`）跑了 8 分 44 秒
 * 还没建完 `node_modules`，而之后每次启动只要几百毫秒。
 *
 * 于是有两个后果，都要靠这个模块判断：
 *
 *   1. **预算**：冷启动按 15 秒掐，等于每次都在下载没结束时就杀掉进程
 *      （见 probe.js 的 `COLD_START_TIMEOUT_MS`）。
 *   2. **别掐断**：npm 被中途杀死留下的是**半成品**——空的嵌套 `node_modules`、
 *      `.package-lock.json` 里记成 `{}`、外加一堆 `.pkg-随机串` 暂存目录。
 *      这种状态 npm 永不自愈，下次跑还是失败。所以冷启动超时后要放手让它跑完
 *      （见 probe.js 的 linger）。
 *
 * 判定刻意保守：拿不准一律返回 `undefined`（按热启动处理）。宁可少给一次长预算，
 * 也不要让每个服务都干等一分钟。
 */

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const WIN32 = "win32";

/**
 * 命令本身就是包运行器（`npx -y <pkg>` 这种形态）。
 *
 * `cache` 字段标出「包最终解到哪里」，只有能**精确**判断的才填 —— 拿不准的
 * 一律 `null`，对应 `isColdStart` 返回 `undefined`：
 *   · npm 系 → `~/.npm/_npx/<hash>/node_modules/<pkg>`（可直接查目录）
 *   · pnpm / bun / uv / pipx 的缓存布局各不相同且会变，不做猜测
 */
const BARE_RUNNERS = Object.freeze({
  npx: { id: "npx", cache: "npm" },
  pnpx: { id: "pnpx", cache: null },
  bunx: { id: "bunx", cache: null },
  uvx: { id: "uvx", cache: null },
  pipx: { id: "pipx", cache: null },
});

/**
 * 需要子命令才算包运行器的通用 CLI。
 *
 * 只收录语义等价于「下载并运行一个包」的那几个 —— `npm run x` / `bun build`
 * 之类是普通命令，不该被当成包运行器。
 */
const SUBCOMMAND_RUNNERS = Object.freeze({
  npm: { cache: "npm" },
  pnpm: { cache: null },
  bun: { cache: null },
  yarn: { cache: null },
  uv: { cache: null },
});

/** 上面各 CLI 里表示「执行一个包」的子命令（`uv tool run` 也算）。 */
const RUNNER_SUBCOMMANDS = Object.freeze({
  npm: ["exec", "x"],
  pnpm: ["dlx"],
  bun: ["x"],
  yarn: ["dlx"],
  uv: ["tool"],
});

/** 取值是「包名」的选项（其余选项一律跳过）。 */
const PACKAGE_FLAGS = Object.freeze(["-p", "--package", "-c", "--call"]);

/**
 * 定位用户主目录。
 *
 * 显式传入的优先；否则看 `$HOME`，它是空串时再问 `os.homedir()`（后者会查账号
 * 数据库，不依赖环境变量）。桌面版从 launchd 继承环境，`HOME` 不保证总在。
 *
 * @param {string} [explicit]
 * @returns {string} 取不到则空串。
 */
function homeDirOf(explicit) {
  if (typeof explicit === "string" && explicit !== "") return explicit;
  const env = process.env.HOME;
  if (typeof env === "string" && env !== "") return env;
  try {
    return homedir();
  } catch {
    return "";
  }
}

/**
 * 取命令的可执行名。
 *
 * 配置里可能是裸命令（`npx`）、绝对路径（`/opt/homebrew/bin/npx`），
 * Windows 上还常带扩展名（`npx.cmd`）—— 三种都要归一到同一个标识。
 *
 * @param {string} command
 * @returns {string}
 */
export function commandBaseName(command) {
  const value = typeof command === "string" ? command.trim() : "";
  if (value === "") return "";
  const last = value.split(/[\\/]/).pop() ?? "";
  return last.replace(/\.(cmd|exe|bat|ps1)$/i, "").toLowerCase();
}

/**
 * 这个命令是不是包运行器？
 *
 * @param {string} command
 * @param {string[]} [args] 需要看子命令时传入。
 * @returns {{ id: string, kind: string, cache: string|null }|undefined}
 */
export function packageRunnerOf(command, args = []) {
  const name = commandBaseName(command);
  if (name === "") return undefined;

  const bare = BARE_RUNNERS[name];
  if (bare !== undefined) return { ...bare, kind: "bare" };

  const sub = SUBCOMMAND_RUNNERS[name];
  if (sub === undefined) return undefined;

  const first = String((Array.isArray(args) ? args : [])[0] ?? "");
  if (!RUNNER_SUBCOMMANDS[name].includes(first)) return undefined;
  return { id: name, kind: "subcommand", cache: sub.cache };
}

/**
 * 剥掉版本后缀：`pkg@1.2.3` → `pkg`，`@scope/pkg@1.2.3` → `@scope/pkg`。
 *
 * npx 解包后的目录名不含版本，所以查缓存时必须先剥掉；scoped 包开头那个 `@`
 * 要留着，因此只从第 2 个字符往后找。
 *
 * @param {string} spec
 * @returns {string}
 */
export function packageNameOf(spec) {
  let value = typeof spec === "string" ? spec.trim() : "";
  if (value === "") return "";
  const at = value.indexOf("@", 1);
  if (at !== -1) value = value.slice(0, at);
  return value;
}

/**
 * 从参数列表里挑出「要运行的那个包」。
 *
 * `npx` 的语义是 `npx [options] <command> [args…]`，`<command>` 可以是包名也可以
 * 是本地已有的命令名；这里只做**语法上**的挑拣，不做存在性判断。
 *
 * @param {string[]} args
 * @returns {string} 剥好版本的包名；找不到则空串。
 */
export function commandPackageOf(args) {
  const list = Array.isArray(args) ? args.map(String) : [];
  for (let index = 0; index < list.length; index += 1) {
    const item = list[index];
    if (item === "--") continue;
    if (item.startsWith("--package=")) return packageNameOf(item.slice("--package=".length));
    if (PACKAGE_FLAGS.includes(item)) return packageNameOf(list[index + 1] ?? "");
    if (item.startsWith("-")) continue;
    return packageNameOf(item);
  }
  return "";
}

/**
 * 一份配置对应的包运行器与包名。
 *
 * @param {object} config 官方形态配置（transport / command / args）。
 * @returns {{ runner: object, pkg: string }|undefined}
 */
export function packageSpecOf(config) {
  if (config === null || typeof config !== "object") return undefined;
  if (config.transport !== "stdio") return undefined;
  const args = Array.isArray(config.args) ? config.args.map(String) : [];
  const runner = packageRunnerOf(config.command, args);
  if (runner === undefined) return undefined;
  return { runner, pkg: commandPackageOf(args) };
}

/**
 * npx 缓存里有没有这个包。
 *
 * 不重算 npx 的目录哈希（那要复刻它的内部算法，一旦变动就静默失效），改成
 * 扫一遍 `~/.npm/_npx/<hash>/node_modules/<pkg>` —— 只要历史上装过一次就算命中。
 * 代价是「装了旧版本」也算热，但对超时预算来说是安全方向（旧版本同样不需要
 * 重新下载）。
 *
 * @param {string} pkg 包名（可带 scope，不带版本）。
 * @param {object} [options]
 * @param {string} [options.home]
 * @param {string} [options.platform]
 * @param {(path: string) => boolean} [options.exists] 便于单测注入。
 * @param {(path: string) => string[]} [options.readdir] 便于单测注入。
 * @returns {boolean|undefined} `undefined` = 判断不了（没有 home、读不了目录）。
 */
export function npxCacheHit(pkg, options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform === WIN32) return undefined;

  const name = typeof pkg === "string" ? pkg.trim() : "";
  if (name === "" || name.startsWith("-")) return undefined;

  // `$HOME` 空了还有 `os.homedir()` 兜底（它会去查账号数据库）——
  // 桌面版从 launchd 拿环境，不保证一定有 HOME，而这里一失手就退回 15 秒预算。
  const home = homeDirOf(options.home);
  if (home === "") return undefined;

  const exists = options.exists ?? existsSync;
  const readdir = options.readdir ?? readdirSync;
  const root = join(home, ".npm", "_npx");
  if (!exists(root)) return false;

  let entries;
  try {
    entries = readdir(root);
  } catch {
    return undefined;
  }
  if (!Array.isArray(entries)) return undefined;

  for (const entry of entries) {
    if (exists(join(root, String(entry), "node_modules", name))) return true;
  }
  return false;
}

/**
 * 这次启动要不要现下载依赖。
 *
 * @param {object} config
 * @param {object} [options] 透传给 `npxCacheHit`（home / exists / readdir / platform）。
 * @returns {boolean|undefined} `true` = 冷（要下载）；`undefined` = 判断不了。
 */
export function isColdStart(config, options = {}) {
  const spec = packageSpecOf(config);
  if (spec === undefined) return undefined;
  // 只有能精确查缓存的族才下结论，其余一律「未知」。
  if (spec.runner.cache !== "npm") return undefined;
  if (spec.pkg === "") return undefined;

  const hit = npxCacheHit(spec.pkg, options);
  if (hit === undefined) return undefined;
  return !hit;
}
