/**
 * 魔搭广场记录 → DSH MCP 配置 的转换器。
 *
 * DSH 的 @deepseek-ai/dsh-mcp-client 只认两种 transport：
 *   - stdio            ← 广场的 ServerConfig（command / args / env）
 *   - streamable-http  ← 广场的 StreamableHTTPServerConfig（url）
 * 它不支持 SSE，因此 SSEServerConfig 只能作为「不可直连」的提示。
 *
 * 实测 120 条样本：ServerConfig 覆盖 82.5%，StreamableHTTPServerConfig 5.8%，
 * SSE 2.5%，即约 88% 的服务可直接安装。
 */

/** DSH 对 serverName 的硬约束（见 dsh-mcp-client 的配置 schema）。 */
export const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

export const SERVER_NAME_MAX_LENGTH = 32;

/** 安装方式。 */
export const INSTALL_KIND = {
  /** 远程直连（streamable-http）。 */
  REMOTE: "remote",
  /** 本地拉起（stdio，npx / uvx 等）。 */
  LOCAL: "local",
  /** 广场只给了 SSE 地址，DSH 不支持。 */
  UNSUPPORTED: "unsupported",
};

/**
 * 判断一条广场记录能否安装到 DSH，并给出首选方案。
 *
 * @param {object} server 已规整的记录（见 modelscope/client.js 的 normalizeServer）。
 * @returns {{ kind: string, reason: string }} 安装可行性。
 */
export function resolveInstallKind(server) {
  if (pickRemote(server)) {
    return { kind: INSTALL_KIND.REMOTE, reason: "服务方提供可直连的 MCP 地址" };
  }
  if (pickLocal(server)) {
    return { kind: INSTALL_KIND.LOCAL, reason: "使用本地命令拉起服务" };
  }
  if (Array.isArray(server?.sseConfig) && server.sseConfig.length > 0) {
    return { kind: INSTALL_KIND.UNSUPPORTED, reason: "服务仅提供 SSE 地址，DSH 暂不支持该协议" };
  }
  return { kind: INSTALL_KIND.UNSUPPORTED, reason: "该服务未提供可用的连接配置" };
}

/**
 * 生成一份可直接写入 cordis.patch.yml 的 DSH MCP 配置。
 *
 * @param {object} server 已规整的记录。
 * @param {object} [options]
 * @param {string} [options.serverName] 指定 serverName；不传则自动生成。
 * @param {Iterable<string>} [options.taken] 已被占用的 serverName 集合（用于去重）。
 * @param {boolean} [options.preferLocal] 即使有远程地址也优先用本地方式。
 * @param {Record<string,string>} [options.env] 用户填写的环境变量。
 * @returns {{ ok: boolean, kind?: string, serverName?: string, config?: object, reason?: string, envFields?: object[] }}
 */
export function buildInstallPlan(server, options = {}) {
  const { serverName, taken, preferLocal = false, env = {} } = options;

  const remote = preferLocal ? undefined : pickRemote(server);
  const local = pickLocal(server);
  const chosen = remote ?? local;

  if (chosen === undefined) {
    const kind = resolveInstallKind(server);
    return { ok: false, kind: kind.kind, reason: kind.reason };
  }

  const name = uniqueServerName(serverName || chosen.name || server?.name || "mcp-server", taken);
  const common = {
    serverName: name,
    toolCallTimeoutMs: 60000,
    failOnStartupError: false,
    reconnect: { enabled: true, initialDelayMs: 500, maxDelayMs: 30000, maxAttempts: 10 },
  };

  if (remote !== undefined) {
    return {
      ok: true,
      kind: INSTALL_KIND.REMOTE,
      serverName: name,
      config: {
        ...common,
        transport: "streamable-http",
        url: remote.url,
        headers: mergeEnvIntoHeaders(remote, env),
      },
      envFields: envFieldsOf(server),
    };
  }

  return {
    ok: true,
    kind: INSTALL_KIND.LOCAL,
    serverName: name,
    config: {
      ...common,
      transport: "stdio",
      command: local.command,
      args: Array.isArray(local.args) ? local.args.map(String) : [],
      env: mergeEnv(local.env, env),
      cwd: "",
    },
    envFields: envFieldsOf(server),
  };
}

/** 取可直连的远程配置（要求带 url）。 */
function pickRemote(server) {
  const list = Array.isArray(server?.streamableHttpConfig) ? server.streamableHttpConfig : [];
  for (const entry of list) {
    if (typeof entry?.url === "string" && entry.url !== "") {
      return { name: entry.name, url: entry.url, headers: entry.headers };
    }
  }
  return undefined;
}

/** 取本地拉起配置（要求带 command）。 */
function pickLocal(server) {
  const list = Array.isArray(server?.serverConfig) ? server.serverConfig : [];
  for (const entry of list) {
    if (typeof entry?.command === "string" && entry.command !== "") {
      return { name: entry.name, command: entry.command, args: entry.args, env: entry.env };
    }
  }
  return undefined;
}

/**
 * 环境变量：广场给的占位值（如 `<必填...>`）不写入，只保留用户实际填写的值。
 */
function mergeEnv(declared, provided) {
  const out = {};
  for (const [key, value] of Object.entries(declared ?? {})) {
    if (isPlaceholder(value)) continue;
    out[key] = String(value);
  }
  for (const [key, value] of Object.entries(provided ?? {})) {
    if (typeof value === "string" && value !== "") out[key] = value;
  }
  return out;
}

/** 远程服务的环境变量按 MCP 惯例放进 headers。 */
function mergeEnvIntoHeaders(remote, provided) {
  const out = {};
  for (const [key, value] of Object.entries(remote?.headers ?? {})) {
    if (typeof value === "string" && !isPlaceholder(value)) out[key] = value;
  }
  for (const [key, value] of Object.entries(provided ?? {})) {
    if (typeof value === "string" && value !== "") out[key] = value;
  }
  return out;
}

/** 广场用 `<...>` 包裹占位说明，这类值不能直接当配置用。 */
function isPlaceholder(value) {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return trimmed === "" || (trimmed.startsWith("<") && trimmed.endsWith(">"));
}

function envFieldsOf(server) {
  const fields = server?.envSchema?.fields;
  return Array.isArray(fields) ? fields : [];
}

/**
 * 把任意名字清洗成合法的 serverName：只留 [A-Za-z0-9_-]，并截断到 32 位。
 *
 * @param {string} raw 原始名字。
 * @param {Iterable<string>} [taken] 已占用的名字集合。
 * @returns {string} 合法且未占用的 serverName。
 */
export function uniqueServerName(raw, taken) {
  const used = taken instanceof Set ? taken : new Set(taken ?? []);
  const base = sanitizeServerName(raw);
  if (!used.has(base)) return base;

  for (let index = 2; index < 1000; index += 1) {
    const suffix = `-${index}`;
    const candidate = base.slice(0, SERVER_NAME_MAX_LENGTH - suffix.length) + suffix;
    if (!used.has(candidate)) return candidate;
  }
  // 理论上到不了这里；兜底保证满足 schema。
  return base.slice(0, SERVER_NAME_MAX_LENGTH - 7) + "-" + Date.now().toString(36).slice(-6);
}

function sanitizeServerName(raw) {
  let name = String(raw ?? "")
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");

  if (name.length > SERVER_NAME_MAX_LENGTH) name = name.slice(0, SERVER_NAME_MAX_LENGTH);
  name = name.replace(/-+$/, "");
  if (name === "") name = "mcp-server";
  return name;
}

/**
 * 由广场记录推导一个可读的展示名（优先中文名）。
 */
export function displayNameOf(server) {
  const chinese = typeof server?.chineseName === "string" ? server.chineseName.trim() : "";
  if (chinese !== "") return chinese;
  const name = typeof server?.name === "string" ? server.name.trim() : "";
  if (name !== "") return name;
  return typeof server?.publisher === "string" ? server.publisher : "未命名服务";
}
