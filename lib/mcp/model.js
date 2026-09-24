/**
 * MCP 配置模型：patch 行 ↔ 官方 dsh-mcp-client 配置 ↔ 前端视图。
 *
 * 保留 UI 层的「键名」信息：env / headers 这类映射只暴露键名与值，
 * 让前端能展示「已配置哪些变量」而无需把密钥读回浏览器。
 */

import {
  MANAGED_ROW_ID_PREFIX,
  MCP_PLUGIN_NAME,
  rowIdForServerName,
  serverNameFromRowId,
} from "./patch-editor.js";

/** serverName 的硬约束，与 dsh-mcp-client 的 schema 保持一致。 */
export const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

export const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60000;

export const DEFAULT_RECONNECT = Object.freeze({
  enabled: true,
  initialDelayMs: 500,
  maxDelayMs: 30000,
  maxAttempts: 10,
});

/** dsh-mcp-client 支持的 transport。 */
export const SUPPORTED_TRANSPORTS = Object.freeze(["stdio", "streamable-http"]);

/**
 * 由配置生成一条 patch 行。
 *
 * @param {object} config 官方形态的配置（须含 serverName 与 transport）。
 * @param {boolean} [enabled] 是否启用；false 时写入 `disabled: true`。
 * @returns {object}
 */
export function toPatchRow(config, enabled = true) {
  return {
    id: rowIdForServerName(config.serverName),
    name: MCP_PLUGIN_NAME,
    ...(enabled ? {} : { disabled: true }),
    config,
  };
}

/**
 * 读取 patch 行中的 config；行不属于 MCP 客户端或 config 形态异常时返回 undefined。
 *
 * @param {object} row
 * @returns {object|undefined}
 */
export function configFromPatchRow(row) {
  if (row === undefined || row.name !== MCP_PLUGIN_NAME) return undefined;
  if (row.config === null || typeof row.config !== "object" || Array.isArray(row.config)) return undefined;
  return row.config;
}

/**
 * patch 行 → 前端视图。
 *
 * @param {object} row patch 行。
 * @param {object} [runtime] 运行时信息。
 * @param {string|null} [runtime.fiberPhase] loader 中的插件阶段。
 * @param {number} [runtime.toolCount] 已注册的工具数。
 * @param {boolean} [runtime.managed] 是否由本插件管理。
 * @returns {object|undefined}
 */
export function patchRowToView(row, runtime = {}) {
  const config = configFromPatchRow(row);
  if (config === undefined) return undefined;

  const serverName = resolveServerName(row, config);
  if (serverName === undefined) return undefined;

  const transport = SUPPORTED_TRANSPORTS.includes(config.transport) ? config.transport : "unknown";
  const view = {
    serverName,
    transport,
    enabled: row.disabled !== true,
    entryId: typeof row.id === "string" ? row.id : undefined,
    managed: runtime.managed !== false,
    fiberPhase: runtime.fiberPhase ?? null,
    toolCount: Number(runtime.toolCount) || 0,
    toolCallTimeoutMs: Number(config.toolCallTimeoutMs) || DEFAULT_TOOL_CALL_TIMEOUT_MS,
    failOnStartupError: config.failOnStartupError === true,
    reconnect: normalizeReconnect(config.reconnect),
    envKeys: Object.keys(asRecord(config.env)),
    headerKeys: Object.keys(asRecord(config.headers)),
  };

  if (transport === "stdio") {
    view.command = typeof config.command === "string" ? config.command : "";
    view.args = Array.isArray(config.args) ? config.args.map(String) : [];
    view.cwd = typeof config.cwd === "string" ? config.cwd : "";
  } else if (transport === "streamable-http") {
    view.url = typeof config.url === "string" ? config.url : "";
  }

  return view;
}

/**
 * patch 行 → 可编辑的配置输入（前端表单回填用）。
 *
 * 出于安全考虑不把 env / headers 的值读回前端，只回填键名。
 *
 * @param {object} row
 * @returns {object|undefined}
 */
export function inputFromPatchRow(row) {
  const config = configFromPatchRow(row);
  if (config === undefined) return undefined;
  const serverName = resolveServerName(row, config);
  if (serverName === undefined) return undefined;

  const base = {
    serverName,
    transport: SUPPORTED_TRANSPORTS.includes(config.transport) ? config.transport : "stdio",
    toolCallTimeoutMs: Number(config.toolCallTimeoutMs) || DEFAULT_TOOL_CALL_TIMEOUT_MS,
    failOnStartupError: config.failOnStartupError === true,
    reconnect: normalizeReconnect(config.reconnect),
  };

  if (base.transport === "stdio") {
    return {
      ...base,
      command: typeof config.command === "string" ? config.command : "",
      args: Array.isArray(config.args) ? config.args.map(String) : [],
      cwd: typeof config.cwd === "string" ? config.cwd : "",
      envKeys: Object.keys(asRecord(config.env)),
    };
  }
  return {
    ...base,
    url: typeof config.url === "string" ? config.url : "",
    headerKeys: Object.keys(asRecord(config.headers)),
  };
}

/**
 * serverName 的权威来源：config.serverName 优先，其次从受管行 id 反解。
 *
 * @param {object} row
 * @param {object} config
 * @returns {string|undefined}
 */
export function resolveServerName(row, config) {
  const fromConfig = typeof config?.serverName === "string" ? config.serverName : "";
  if (SERVER_NAME_PATTERN.test(fromConfig)) return fromConfig;
  const fromId = serverNameFromRowId(row?.id);
  if (typeof fromId === "string" && SERVER_NAME_PATTERN.test(fromId)) return fromId;
  return undefined;
}

/**
 * 校验一份待写入的配置输入。
 *
 * @param {object} input
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function validateServerInput(input) {
  if (!input || typeof input !== "object") return { ok: false, error: "配置不能为空" };

  const serverName = typeof input.serverName === "string" ? input.serverName.trim() : "";
  if (!SERVER_NAME_PATTERN.test(serverName)) {
    return { ok: false, error: "serverName 只能包含 1-32 位字母、数字、下划线或连字符" };
  }

  if (input.transport === "stdio") {
    const command = typeof input.command === "string" ? input.command.trim() : "";
    if (command === "") return { ok: false, error: "stdio 方式必须填写启动命令" };
    return { ok: true };
  }

  if (input.transport === "streamable-http") {
    const url = typeof input.url === "string" ? input.url.trim() : "";
    if (url === "") return { ok: false, error: "streamable-http 方式必须填写服务地址" };
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return { ok: false, error: "服务地址必须是 http 或 https" };
      }
    } catch {
      return { ok: false, error: "服务地址不是合法的 URL" };
    }
    return { ok: true };
  }

  return { ok: false, error: `不支持的调用方式：${String(input.transport)}` };
}

/** 行 id 是否属于本插件的受管行。 */
export function isManagedRow(row) {
  return typeof row?.id === "string" && row.id.startsWith(MANAGED_ROW_ID_PREFIX);
}

function normalizeReconnect(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    enabled: source.enabled !== false,
    initialDelayMs: positiveInt(source.initialDelayMs, DEFAULT_RECONNECT.initialDelayMs),
    maxDelayMs: positiveInt(source.maxDelayMs, DEFAULT_RECONNECT.maxDelayMs),
    maxAttempts: positiveInt(source.maxAttempts, DEFAULT_RECONNECT.maxAttempts),
  };
}

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
}

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
