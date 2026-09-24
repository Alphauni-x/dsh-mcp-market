/**
 * MCP 行的运行时状态读取：loader 条目、插件阶段、已注册工具数。
 *
 * 写入 patch 后 HMR 需要一点时间生效，因此「写后确认」必须轮询 loader，
 * 否则前端会拿到一个未生效的假成功。
 */

/** Cordis fiber 状态码 → 可读阶段名。 */
const FIBER_PHASE = {
  0: "pending",
  1: "loading",
  2: "active",
  3: "failed",
  4: null,
  5: "unloading",
};

/**
 * @param {unknown} state fiber.state 原始值。
 * @returns {string|null}
 */
export function fiberPhaseOf(state) {
  if (typeof state !== "number") return null;
  const phase = FIBER_PHASE[state];
  return phase === undefined ? null : phase;
}

/**
 * 按 id 取 loader 条目。
 *
 * ⚠️ loader 会给条目加命名空间前缀：`cordis.patch.yml` 里 `insert:` 进来的行，
 * 运行时 id 会变成 `include:<id>`（实测：`mcp-market-memory` →
 * `include:mcp-market-memory`）。只按字面匹配会永远取不到条目，面板上表现为
 * 服务器明明在跑却一直显示「加载中」。所以先精确匹配，再退一步按 `:<id>` 后缀匹配。
 *
 * @param {object} ctx Cordis 上下文。
 * @param {string} id patch 行 id。
 * @returns {object|undefined}
 */
export function getLoaderEntry(ctx, id) {
  const loader = ctx?.loader;
  if (loader === undefined || typeof loader.entries !== "function") return undefined;
  if (typeof id !== "string" || id === "") return undefined;

  let suffixHit;
  for (const entry of loader.entries()) {
    const entryId = entry?.id;
    if (entryId === id) return entry;
    if (suffixHit === undefined && typeof entryId === "string" && entryId.endsWith(`:${id}`)) {
      suffixHit = entry;
    }
  }
  return suffixHit;
}

/**
 * 该 MCP 服务器当前注册了多少个工具（工具名带 `mcp__<serverName>__` 前缀）。
 *
 * 前缀末尾的 `__` 是必须的：少了它，serverName 取 `memo` 时会把 `memory` 的工具一起算进来。
 *
 * `tools.schemas()` 是宿主服务。它抛错就整个 list() 挂掉、面板白屏，所以这里吞掉异常退化成 0——
 * 工具数只是展示用的辅助信息，不值得让整页陪葬。
 *
 * @param {object} ctx
 * @param {string} serverName
 * @returns {number}
 */
export function mcpToolCount(ctx, serverName) {
  const tools = ctx?.tools;
  if (tools === undefined || typeof tools.schemas !== "function") return 0;
  const prefix = `mcp__${serverName}__`;
  let schemas;
  try {
    schemas = tools.schemas();
  } catch {
    return 0;
  }
  if (!Array.isArray(schemas)) return 0;
  return schemas.filter((schema) => typeof schema?.name === "string" && schema.name.startsWith(prefix))
    .length;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 写入 patch 后轮询 loader，直到条目满足 predicate 或超时。
 *
 * @param {object} ctx
 * @param {string} id 目标行 id。
 * @param {(entry: object|undefined) => boolean} predicate
 * @param {number} [timeoutMs] 默认 3000ms，每 200ms 查一次。
 * @returns {Promise<boolean>} 是否在超时前满足。
 */
export async function waitForLoaderState(ctx, id, predicate, timeoutMs = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const entry = getLoaderEntry(ctx, id);
    if (predicate(entry)) return true;
    await delay(200);
  }
  return false;
}
