/**
 * 宿主 PATH 修复。
 *
 * 背景：桌面版（Electron 壳）从 Dock / Finder 启动时，宿主进程只继承 launchd
 * 的默认 PATH（`/usr/bin:/bin:/usr/sbin:/sbin`），里面没有用户自己装的
 * npx / uvx / pnpm。于是所有 stdio 型 MCP 在 spawn 阶段就 ENOENT，而 HTTP 型
 * （直接连 URL、不起本地进程）不受影响 —— 看起来像「有的服务坏了」，其实是
 * 环境缺了一段。
 *
 * 修法：在宿主进程内把候选目录补进 `process.env.PATH`。补这一处就够，因为
 * 官方 `@deepseek-ai/dsh-subprocess` 的 `scrubbedParentEnv()` 每次调用都重新
 * 遍历 `process.env`（不是启动时的快照），而官方 MCP 客户端正是用它拼子进程
 * 环境（`dsh-mcp-client` 的 `buildChildEnv`）；插件与它同处一个宿主进程：
 *
 *     process.env.PATH  ←── 只写这一处
 *         ├─ 我们的 probe.js（scrubbedEnv）
 *         ├─ 官方 dsh-mcp-client（scrubbedParentEnv → buildChildEnv）
 *         └─ 桌面版自身内部的 spawn(npx, …)
 *
 * 因此**不需要**改写任何配置文件，也**不要**把机器相关的绝对路径塞进
 * `cordis.patch.yml`。上游若修掉那个 `void 0` 传参缺陷，本模块会自动退化成
 * 空操作（目录都已在 PATH 中，算出来要补的集合为空）。
 *
 * 三条硬约束：
 *   1. 只 prepend，绝不丢弃原有条目；
 *   2. 只补**实际存在**的目录，且只补原本不在 PATH 上的；
 *   3. 探测失败（拿不到登录 shell 的 PATH、目录不存在）一律静默降级，绝不让
 *      插件加载失败。
 */

import { accessSync, constants as fsConstants, existsSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const WIN32 = "win32";

/**
 * 登录 shell 探测的超时。
 *
 * 实测本机（干净环境，`env -i HOME=$HOME …`）：
 *   `$SHELL -lc  'printf %s "$PATH"'` → ~20ms（只读 .zprofile）
 *   `$SHELL -ilc 'printf %s "$PATH"'` → 1.3~1.7s（还要 source .zshrc，有副作用）
 * 所以只用 `-lc`。给 2s 余量，但绝不长等。
 */
const LOGIN_SHELL_TIMEOUT_MS = 2000;

/**
 * `$SHELL` 缺失时的回落候选。
 *
 * Electron 从 Dock 启动时宿主环境里不保证有 `SHELL`（它来自 launchd，不是 shell
 * 自己导出的），所以不能只依赖它 —— 否则登录 shell 探测会静默失效，只剩静态候选
 * 目录可用。这里按平台常见顺序各试一个，都不存在就放弃（由调用方退回静态目录）。
 */
const FALLBACK_SHELLS = ["/bin/zsh", "/bin/bash", "/bin/sh"];

/** 两个开关的默认值。 */
export const DEFAULT_PATH_FIX = Object.freeze({ fixHostPath: true, probeLoginShell: true });

/**
 * 从插件 config 里取 PATH 修复相关的开关。
 *
 * @param {object} [config] cordis.patch.yml 中本插件的 config 块。
 * @returns {{ fixHostPath: boolean, probeLoginShell: boolean }}
 */
export function normalizePathFix(config) {
  const source = config !== null && typeof config === "object" ? config : {};
  return {
    fixHostPath: source.fixHostPath === undefined ? DEFAULT_PATH_FIX.fixHostPath : source.fixHostPath === true,
    probeLoginShell:
      source.probeLoginShell === undefined ? DEFAULT_PATH_FIX.probeLoginShell : source.probeLoginShell === true,
  };
}

/**
 * 读宿主当前的 PATH。Windows 上 Node 可能把键写成 `Path`。
 *
 * @param {Record<string, string|undefined>} [env]
 * @param {string} [platform]
 * @returns {string}
 */
export function currentPath(env = process.env, platform = process.platform) {
  if (platform === WIN32) return String(env.Path ?? env.PATH ?? "");
  return String(env.PATH ?? "");
}

/**
 * 按平台切分 PATH。
 *
 * 空段（连续分隔符、结尾分隔符）会被丢弃 —— 空段在 POSIX 上表示「当前目录」，
 * 把工作目录塞进子进程的搜索路径不是我们想要的效果。
 *
 * @param {string} value
 * @param {string} [platform]
 * @returns {string[]}
 */
export function splitPath(value, platform = process.platform) {
  const separator = platform === WIN32 ? ";" : ":";
  return String(value ?? "")
    .split(separator)
    .filter((part) => part !== "");
}

/**
 * @param {string[]} parts
 * @param {string} [platform]
 * @returns {string}
 */
export function joinPath(parts, platform = process.platform) {
  return parts.join(platform === WIN32 ? ";" : ":");
}

/**
 * 去重，保留首次出现的顺序（与 PATH 实际的查找顺序一致：靠前者胜）。
 *
 * @param {string[]} parts
 * @returns {string[]}
 */
export function dedupeDirs(parts) {
  const seen = new Set();
  const out = [];
  for (const part of parts) {
    if (typeof part !== "string" || part === "" || seen.has(part)) continue;
    seen.add(part);
    out.push(part);
  }
  return out;
}

/**
 * 候选目录：用户自己装命令时最常落的地方。
 *
 * 刻意**不含**应用内部目录（`DeepSeek Harness.app/Contents/Resources/runtime/…`）——
 * 那儿只有自带的 node 与 pnpm，既没有 npx 也没有 npm，指向它对解决问题毫无帮助。
 *
 * @param {{ home?: string, platform?: string }} [options]
 * @returns {string[]}
 */
export function candidateDirs(options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform === WIN32) return [];
  const home = typeof options.home === "string" ? options.home : "";
  const dirs = [];
  if (home !== "") {
    dirs.push(join(home, ".local", "bin"), join(home, "Library", "pnpm"), join(home, ".bun", "bin"));
  }
  dirs.push("/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin");
  return dirs;
}

/**
 * 命令是否已经是路径形态（含分隔符）。
 *
 * 路径形态的命令**不走 PATH 查找**，所以「找不到」不能归咎于 PATH，
 * 报错文案也要分开写。
 *
 * @param {string} command
 * @param {string} [platform]
 * @returns {boolean}
 */
export function isPathLikeCommand(command, platform = process.platform) {
  const name = typeof command === "string" ? command.trim() : "";
  if (name === "") return false;
  if (platform === WIN32) {
    return /^[A-Za-z]:[\\/]/.test(name) || name.startsWith("\\\\") || name.includes("\\") || name.includes("/");
  }
  return name.startsWith("/") || name.includes("/");
}

function defaultIsExecutable(file) {
  try {
    accessSync(file, fsConstants.X_OK);
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * 解析一个命令。
 *
 * @param {string} command 命令名或路径。
 * @param {string} pathValue 用于查找的 PATH。
 * @param {object} [options]
 * @param {string} [options.platform]
 * @param {(file: string, platform: string) => boolean} [options.isExecutable] 便于单测注入。
 * @param {string} [options.pathext] Windows 专用。
 * @returns {string|undefined} 解析到的路径；`undefined` 专指「需要查 PATH 但没找到」。
 */
export function resolveOnPath(command, pathValue, options = {}) {
  const platform = options.platform ?? process.platform;
  const isExecutable = options.isExecutable ?? defaultIsExecutable;
  const name = typeof command === "string" ? command.trim() : "";
  if (name === "") return undefined;
  // 路径形态：不查 PATH，原样交还（PATH 不是问题所在）。
  if (isPathLikeCommand(name, platform)) return name;

  const extensions = platform === WIN32 ? String(options.pathext ?? ".COM;.EXE;.BAT;.CMD").split(";") : [""];
  for (const dir of splitPath(pathValue, platform)) {
    const trimmed = dir.endsWith("/") || dir.endsWith("\\") ? dir.slice(0, -1) : dir;
    for (const extension of extensions) {
      const candidate = `${trimmed}/${name}${extension}`;
      if (isExecutable(candidate, platform)) return candidate;
    }
  }
  return undefined;
}

/**
 * 把一个「起不来」的命令翻译成能照着做的中文提示。
 *
 * 原始报错是 `spawn uvx ENOENT` / `spawn /x/y ENOENT`，既看不出是「没装」还是
 * 「装了但不在 PATH 上」，也不知道下一步该做什么。这里把两种情形分开：
 * 路径形态 → 文件不存在或没有执行权限；命令名 → 不在宿主 PATH 中。
 *
 * @param {string} command
 * @param {string} pathValue 用于判断的 PATH。
 * @param {object} [options] 同 resolveOnPath。
 * @returns {string|undefined} 需要提示时返回文案；命令本身没问题则返回 `undefined`。
 */
export function diagnoseCommand(command, pathValue = "", options = {}) {
  const platform = options.platform ?? process.platform;
  const isExecutable = options.isExecutable ?? defaultIsExecutable;
  const name = typeof command === "string" ? command.trim() : "";
  if (name === "") return undefined;

  if (isPathLikeCommand(name, platform)) {
    return isExecutable(name, platform)
      ? undefined
      : `找不到可执行文件 "${name}"：该路径不存在，或没有执行权限。`;
  }
  if (resolveOnPath(name, pathValue, options) !== undefined) return undefined;

  return `找不到命令 "${name}"：它不在宿主进程的 PATH 中。请确认该命令已安装，或在其配置的 env 里补一条 PATH。`;
}

/**
 * 选一个可用的登录 shell。
 *
 * 顺序：调用方显式指定 → `$SHELL` → 平台常见默认。都不存在则返回 `""`。
 *
 * @param {string|undefined} explicit
 * @param {(path: string) => boolean} [exists] 便于单测注入。
 * @returns {string}
 */
export function resolveLoginShell(explicit, exists = existsSync) {
  const preferred = [];
  if (typeof explicit === "string" && explicit !== "") preferred.push(explicit);
  else if (typeof process.env.SHELL === "string" && process.env.SHELL !== "") preferred.push(process.env.SHELL);
  preferred.push(...FALLBACK_SHELLS);
  for (const shell of preferred) {
    if (exists(shell)) return shell;
  }
  return "";
}

/**
 * 取登录 shell 自己的 PATH。
 *
 * 任何异常、超时、退出码非 0、输出里带换行（说明 shell 打了横幅或其它杂音）
 * 都返回空串，由调用方退回静态候选目录 —— 探测失败绝不能让插件加载失败。
 *
 * @param {object} [options]
 * @param {string} [options.shell] 默认 `$SHELL`，再回落到 `/bin/zsh`、`/bin/bash`、`/bin/sh`。
 * @param {number} [options.timeoutMs]
 * @param {string} [options.platform]
 * @param {Record<string,string|undefined>} [options.env]
 * @param {Function} [options.spawnSync] 便于单测注入。
 * @returns {string} PATH，取不到则为 `""`。
 */
export function probeLoginShellPath(options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform === WIN32) return "";

  const shell = resolveLoginShell(options.shell ?? (options.env ?? process.env).SHELL);
  if (shell === "") return "";

  const run = options.spawnSync ?? spawnSync;
  let result;
  try {
    result = run(shell, ["-lc", 'printf %s "$PATH"'], {
      timeout: options.timeoutMs ?? LOGIN_SHELL_TIMEOUT_MS,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...(options.env ?? process.env) },
    });
  } catch {
    return "";
  }

  if (result === null || typeof result !== "object") return "";
  if (result.error !== undefined && result.error !== null) return "";
  if (Number(result.status) !== 0) return "";

  const value = String(result.stdout ?? "").trim();
  if (value === "" || value.includes("\n") || !value.includes("/")) return "";
  return value;
}

/**
 * 算出「该补哪些目录」以及补完之后的 PATH。纯函数，不碰 `process.env`。
 *
 * 幂等保证：没有可补的目录时**原样返回 current**，连归一化都不做 ——
 * 这样已经正常的环境（终端启动的宿主）一个字节都不会被改动。
 *
 * @param {object} options
 * @param {string} options.current 当前 PATH。
 * @param {string} [options.home]
 * @param {string} [options.platform]
 * @param {(dir: string) => boolean} [options.exists]
 * @param {string[]} [options.candidates] 覆盖默认候选目录（测试用）。
 * @param {string[]} [options.extraDirs] 额外要补的目录。
 * @param {string} [options.loginShellPath] 登录 shell 的 PATH（作为补充来源）。
 * @returns {{ add: string[], after: string, current: string }}
 */
export function planPathFix(options = {}) {
  const platform = options.platform ?? process.platform;
  const current = String(options.current ?? "");
  const exists = options.exists ?? existsSync;
  const home = options.home ?? "";

  const wanted = dedupeDirs([
    ...(options.candidates ?? candidateDirs({ home, platform })),
    ...splitPath(options.loginShellPath ?? "", platform),
    ...(options.extraDirs ?? []),
  ]);
  const present = splitPath(current, platform);
  const add = wanted.filter((dir) => !present.includes(dir) && exists(dir));
  if (add.length === 0) return { add: [], after: current, current };

  return { add, after: joinPath(dedupeDirs([...add, ...present]), platform), current };
}

/**
 * 把候选目录补进 `env.PATH`（默认就是 `process.env`）。
 *
 * @param {object} [options]
 * @param {Record<string,string|undefined>} [options.env]
 * @param {string} [options.platform]
 * @param {boolean} [options.enabled] 传 false 直接跳过（对应 `fixHostPath: false`）。
 * @param {string} [options.home]
 * @param {(dir: string) => boolean} [options.exists]
 * @param {string[]} [options.candidates]
 * @param {string[]} [options.extraDirs]
 * @param {string} [options.loginShellPath]
 * @returns {{ changed: boolean, before: string, after: string, added: string[], skipped: string }}
 *   `skipped` 取值：`unsupported-platform` / `disabled` / `nothing-to-add` / `""`（已改动）。
 */
export function ensureHostPath(options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const before = currentPath(env, platform);
  const report = { changed: false, before, after: before, added: [], skipped: "" };

  if (platform === WIN32) {
    report.skipped = "unsupported-platform";
    return report;
  }
  if (options.enabled === false) {
    report.skipped = "disabled";
    return report;
  }

  const plan = planPathFix({
    platform,
    current: before,
    home: options.home ?? env.HOME ?? "",
    exists: options.exists,
    candidates: options.candidates,
    extraDirs: options.extraDirs,
    loginShellPath: options.loginShellPath,
  });
  if (plan.add.length === 0) {
    report.skipped = "nothing-to-add";
    return report;
  }

  env.PATH = plan.after;
  report.changed = true;
  report.after = plan.after;
  report.added = plan.add;
  return report;
}
