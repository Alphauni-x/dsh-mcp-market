/**
 * MCP 连接探针：临时连一次服务并列出其工具。
 *
 * 不写 patch、不注册 DSH 工具，只用于「测试连接」——包括安装前预检，
 * 让用户在真正写入配置之前就知道这个服务能不能起来。
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { diagnoseCommand } from "./host-path.js";
import { isColdStart } from "./package-runner.js";

/** 单次探测的总超时（热启动路径）。 */
const PROBE_TIMEOUT_MS = 15000;

/**
 * 需要现下载依赖时的预算。
 *
 * 实测 `npx -y 12306-mcp` 首次要装 200+ 个包，8 分 44 秒还没建完 `node_modules`。
 * 给 60 秒不是因为它够 —— 是因为再长用户只会以为卡死了。真正兜底的是超时后的
 * `LINGER_MS`：把进程放走让它继续装，下次点「测试连接」就命中缓存了。
 */
const COLD_START_TIMEOUT_MS = 60000;

/**
 * 冷启动超时后，放手让子进程继续跑多久。
 *
 * 这一条才是「装了但一直用不了」的根治：npm 被中途杀死留下的是**半成品**
 * （空的嵌套 `node_modules`、`.package-lock.json` 记成 `{}`、一堆
 * `.pkg-随机串` 暂存目录），npx 下次不会自愈，于是每点一次「测试连接」
 * 就把安装掐断一次，永远装不上。
 */
const LINGER_MS = 180000;

/** stderr 尾部保留的字节上限。只用来解释「为什么崩了」，不需要全文。 */
const STDERR_TAIL_BYTES = 2000;

/** 展示给用户时最多保留几行 stderr。 */
const STDERR_TAIL_LINES = 6;

/** ANSI 转义序列（颜色、光标移动）：终端里好看，嵌进文案里是噪音。 */
const ANSI_RE = /\u001B\[[0-9;?]*[A-Za-z]/g;

const CLIENT_INFO = { name: "dsh-mcp-market", version: "0.1.0" };

/**
 * 探测一个 MCP 服务。
 *
 * 任何失败都收敛成 `{ ok: false, error }`，不抛异常 —— 探测失败是预期内的常见结果。
 *
 * @param {object} config 官方形态配置（transport / command+args 或 url）。
 * @param {number} [timeoutMs] 预算下限；冷启动会被自动放大到 `COLD_START_TIMEOUT_MS`。
 * @param {object} [options]
 * @param {string} [options.home] 冷启动判定的缓存根目录（默认 `$HOME`）。
 * @param {(path: string) => boolean} [options.exists] 便于单测注入。
 * @param {(path: string) => string[]} [options.readdir] 便于单测注入。
 * @returns {Promise<{ ok: boolean, tools: {name: string, description?: string}[], error?: string }>}
 */
export async function probeMcpServer(config, timeoutMs = PROBE_TIMEOUT_MS, options = {}) {
  // 冷启动判定只影响预算与「超时后要不要放走进程」，不影响探测本身。
  const cold = isColdStart(config, options);
  const budgetMs = resolveBudget(timeoutMs, cold);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budgetMs);
  const client = new Client(CLIENT_INFO);
  let transport;
  let tail = EMPTY_TAIL;
  let linger = false;

  try {
    transport = createTransport(config);
    // 必须在 connect 之前挂 —— SDK 的 stderr 是一个提前返回的 PassThrough，
    // 就是为了让调用方能收住子进程启动初期（也正是报错最多的时候）的输出。
    tail = collectStderr(transport);
    await raceWithAbort(client.connect(transport), controller.signal);

    const tools = [];
    let cursor;
    do {
      const page = await client.listTools(cursor === undefined ? undefined : { cursor }, {
        signal: controller.signal,
      });
      for (const tool of page.tools ?? []) {
        tools.push({
          name: String(tool.name),
          ...(typeof tool.description === "string" ? { description: tool.description } : {}),
        });
      }
      cursor = page.nextCursor;
    } while (cursor !== undefined && cursor !== "");

    return { ok: true, tools };
  } catch (error) {
    const aborted = controller.signal.aborted;
    // 超时。冷启动时**不要**关进程：那一刻它多半正在 npm 解包，杀掉就前功尽弃，
    // 而且是「下次还是半成品」的死循环。放它跑完，缓存就建起来了。
    linger = aborted && cold === true;
    const reason = aborted ? timeoutReason(budgetMs, cold) : describeSpawnFailure(error, config);
    // 三段各管一件事：为什么失败 / 子进程说了什么 / 能照着做什么。
    const parts = [reason, stderrTail(tail), recoveryHint(tail)].filter((part) => part !== "");
    return { ok: false, tools: [], error: parts.join("\n") };
  } finally {
    clearTimeout(timer);
    // 结果已经定了，回收动作不参与返回路径。实测一次 stdio 探测的 close 要等
    // 约 70ms（等子进程退干净），让用户为进程回收买单没有道理。
    if (linger) scheduleLingeringClose(client, transport);
    else closeInBackground(client, transport);
  }
}

/**
 * 按冷启动放大预算。
 *
 * 只在调用方**没有自己的主张**（用的就是默认值）时才放大；一旦显式传了别的
 * 数字，就完全按它来。这样网关白拿冷启动的长预算，而测试能给到毫秒级的预算
 * 去验证超时路径。
 *
 * @param {number} timeoutMs
 * @param {boolean|undefined} cold
 * @returns {number}
 */
function resolveBudget(timeoutMs, cold) {
  if (cold !== true) return timeoutMs;
  return timeoutMs === PROBE_TIMEOUT_MS ? COLD_START_TIMEOUT_MS : timeoutMs;
}

/** 超时文案。冷启动跟「服务自己不回应」是两件事，说法要分开。 */
function timeoutReason(budgetMs, cold) {
  if (cold !== true) return `连接测试超时（${budgetMs}ms）`;
  const seconds = Math.round(budgetMs / 1000);
  return (
    `首次运行需要下载依赖，已等待 ${seconds} 秒仍未就绪。` +
    `安装已转到后台继续，约一分钟后重试即可 —— 不必重新安装或改配置。`
  );
}

/**
 * 挂上 stderr 收集器。
 *
 * `StdioClientTransport` 默认 `stderr: "inherit"`，子进程的报错直接写进宿主
 * stderr —— 用户在界面上看不到任何东西。而「进程起来了又立刻崩」这类失败
 * （界面只会显示 `MCP error -32000: Connection closed`）的真正原因恰好只在
 * 那里：模块解析失败、端口占用、缺 API key，全打在 stderr 上。
 *
 * 还有一个必须做的动作：pipe 出来的流**一定要有人读**。没人消费的话管道缓冲区
 * （64KB）写满后子进程会被写阻塞，卡在那里不动。
 *
 * @param {object} transport
 * @returns {{ text: string }}
 */
function collectStderr(transport) {
  const stream = transport?.stderr ?? null;
  const state = { text: "" };
  if (stream === null || stream === undefined || typeof stream.on !== "function") return state;

  if (typeof stream.setEncoding === "function") stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    state.text = (state.text + String(chunk)).slice(-STDERR_TAIL_BYTES);
  });
  stream.on("error", () => {});
  return state;
}

/** 空的收集结果（HTTP 型、或注入失败时用它兜底，省掉一层判空）。 */
const EMPTY_TAIL = Object.freeze({ text: "" });

/**
 * 把收集到的 stderr 整理成能给用户看的几行。
 *
 * @param {{text: string}} state
 * @returns {string} 为空表示没有可用输出。
 */
function stderrTail(state) {
  const cleaned = String(state?.text ?? "")
    .replace(ANSI_RE, "")
    .trim();
  if (cleaned === "") return "";
  const lines = cleaned
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== "");
  if (lines.length === 0) return "";
  return `子进程输出：\n${lines.slice(-STDERR_TAIL_LINES).join("\n")}`;
}

/** 缓存目录路径（npx 把它建在 `_npx/<hash>` 下）。 */
const NPX_CACHE_RE = /(\/[^\s'"]*\/_npx\/[^/\s'"]+)/;

/**
 * 认出「包缓存被装坏了」这一类失败，并给出能照着做的恢复步骤。
 *
 * 症状是 `ERR_MODULE_NOT_FOUND` 指向 `~/.npm/_npx/<hash>/node_modules/...` 下
 * 的某个深层文件。成因是上回安装被中途打断：npm 先把暂存目录 `.包名-随机串`
 * 建好、再把 `node_modules/<包名>` 建出来，**最后**才往里填文件 —— 在「目录已
 * 建、内容空」的那一刻被杀，留下一个看起来完整、实际上是空壳的目录。
 *
 * 更要命的是 npx 不会自愈：它只看目录在不在，于是每次运行都从壳里加载，
 * 每次都崩在同一处。这种情况只能清掉重装，所以直接把命令写进报错里。
 *
 * @param {{text: string}} state 收集到的原始 stderr。
 * @returns {string} 需要提示时返回一行建议，否则空串。
 */
function recoveryHint(state) {
  const text = String(state?.text ?? "").replace(ANSI_RE, "");
  if (!/MODULE_NOT_FOUND|Cannot find module/.test(text)) return "";
  const match = NPX_CACHE_RE.exec(text);
  if (match === null) return "";
  const dir = match[1].replace(/^\/+/, "/");
  return (
    `这个包的缓存不完整（上次安装被中断，留下一个空壳目录），npx 不会自动修复。` +
    `清掉后重装即可：rm -rf "${dir}"，再在终端里跑一次 npx -y <包名> 等它装完。`
  );
}

/**
 * 后台关闭客户端与传输层。
 *
 * 刻意不 await，也不上报失败：调用方要的是「这个服务能不能用」，而不是
 * 「子进程有没有退干净」。关闭出问题最坏的后果是留一个进程，它会随宿主退出
 * 一并被回收 —— 不值得为此让探测返回得更慢、或者把异常抛进调用栈。
 *
 * @param {object} client
 * @param {object|undefined} transport
 */
function closeInBackground(client, transport) {
  try {
    void Promise.allSettled([
      client.close().catch(() => {}),
      Promise.resolve(transport?.close?.()).catch(() => {}),
    ]);
  } catch {
    // 同步抛出（例如 transport 已被替换）同样忽略。
  }
}

/**
 * 冷启动超时后的延迟回收。
 *
 * 探测已经返回失败（用户看到的是「已转到后台继续」），但子进程留着不动 ——
 * 它正在把包下完。给它 `LINGER_MS` 的时间自行结束，再回收。
 *
 * `unref()` 是必须的：定时器不该拖着宿主进程不让退出。
 *
 * @param {object} client
 * @param {object|undefined} transport
 */
function scheduleLingeringClose(client, transport) {
  try {
    setTimeout(() => closeInBackground(client, transport), LINGER_MS).unref();
  } catch {
    // 没有 unref（或 setTimeout 被替换过）时退回立即回收，别把进程留成孤儿。
    closeInBackground(client, transport);
  }
}

function createTransport(config) {
  if (config?.transport === "stdio") {
    return new StdioClientTransport({
      command: String(config.command ?? ""),
      args: Array.isArray(config.args) ? config.args.map(String) : [],
      env: { ...scrubbedEnv(), ...stringMap(config.env) },
      cwd: config.cwd === "" || config.cwd === undefined ? undefined : String(config.cwd),
      // 默认 "inherit" 会把子进程报错直接写进宿主 stderr（界面看不到），
      // 而「进程起来了又立刻崩」的真因只在那里。详情见 collectStderr。
      stderr: "pipe",
    });
  }
  return new StreamableHTTPClientTransport(new URL(String(config?.url ?? "")), {
    requestInit: { headers: stringMap(config?.headers) },
  });
}

/**
 * 剥掉宿主进程里的敏感环境变量，避免把它们透传给被探测的第三方进程。
 * 仅保留运行所需的最小集合。
 */
function scrubbedEnv() {
  const keep = ["PATH", "HOME", "SHELL", "LANG", "LC_ALL", "TMPDIR", "USER", "SystemRoot", "ComSpec", "PATHEXT"];
  const out = {};
  for (const key of keep) {
    const value = process.env[key];
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

function stringMap(value) {
  const out = {};
  for (const [key, item] of Object.entries(value ?? {})) {
    if (typeof item === "string") out[key] = item;
  }
  return out;
}

/**
 * 把底层 `spawn uvx ENOENT` 换成能照着做的提示。
 *
 * 桌面版从 Dock 启动时宿主只继承 launchd 的默认 PATH，用户自己装的 npx / uvx
 * 不在其中 —— 这是最常见的一类失败。若不加工，界面上只会看到一句 ENOENT，
 * 既不像「命令没装」也不像「配置写错」，完全无从下手。
 *
 * 只对 stdio 生效：HTTP 型失败与 PATH 无关。
 */
function describeSpawnFailure(error, config) {
  // 抛出来的未必是 Error（SDK 里也有直接 reject 字符串的分支），统一成文案。
  const message = error instanceof Error ? error.message : String(error);
  const match = /^spawn (.+?) ENOENT$/.exec(message);
  if (match === null || config?.transport !== "stdio") return message;

  // 配置里的 env.PATH 优先（官方客户端与我们的合并顺序都是它覆盖父进程），
  // 没配才看宿主进程的。
  const configured = stringMap(config.env).PATH;
  const pathValue = typeof configured === "string" ? configured : (process.env.PATH ?? "");
  return diagnoseCommand(match[1], pathValue) ?? message;
}

function raceWithAbort(promise, signal) {
  if (signal.aborted) return Promise.reject(new Error("aborted"));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
