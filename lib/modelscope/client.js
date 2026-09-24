/**
 * 魔搭（ModelScope）MCP 广场 API 客户端。
 *
 * 广场前端是 umi SPA，接口不在 bundle 里；这里用的是从真实网络流量中还原出的调用：
 *   PUT https://modelscope.cn/api/v1/dolphin/mcpServers
 *   body: {"PageSize":30,"PageNumber":1,"Query":"","Criterion":[]}
 * 必须是 PUT —— 用 GET/POST 会得到 "404 page not found"。
 *
 * 该接口未登录即可调用，因此本插件不需要任何魔搭凭证。
 * 所有远端访问都收敛在本文件，接口若变更只需改这里。
 *
 * 两个必须知道的行为（都经过实测，不是猜测）：
 *
 * 1. `Query` 是真正生效的关键词搜索 —— `""` 返回全量第一页，`"finance"` 只返回
 *    20 条命中，`"搜索"` 222 条。而 `Criterion` 完全不生效（换各种字段名都返回
 *    同一个 total）。
 * 2. 匿名访问存在 **偏移 300 的硬上限**：`(PageNumber-1)*PageSize >= 300` 一律返回
 *    空列表且 TotalCount 归零。见 `ANON_OFFSET_LIMIT`。
 *
 * 两条合起来决定了同步策略：单条查询只能看到 300 条，必须靠关键词扇出
 * （`fetchByKeywords`）才能把本地索引做到有意义的覆盖率。
 */

const ORIGIN = "https://modelscope.cn";
const LIST_ENDPOINT = `${ORIGIN}/api/v1/dolphin/mcpServers`;
const HOME_CONFIG_ENDPOINT = `${ORIGIN}/api/v1/console/config/list/business/mcp`;

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/** 广场前端用的每页条数；作为保守默认值。 */
export const DEFAULT_PAGE_SIZE = 30;

/** 列表接口允许的最大每页条数（超出由服务端自行截断，这里只做上限保护）。 */
export const MAX_PAGE_SIZE = 100;

/** 单次请求超时。 */
const DEFAULT_TIMEOUT_MS = 20000;

/** 失败重试：共 3 次尝试，指数退避。 */
const RETRY_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 400;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 广场服务不可用（网络、超时、非 200、Code 非 200）。 */
export class MarketUnavailableError extends Error {
  constructor(message, options) {
    super(message);
    this.name = "MarketUnavailableError";
    this.code = "market/unavailable";
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

/**
 * 调一次列表接口。
 *
 * @param {object} request
 * @param {number} [request.pageNumber] 页码，从 1 开始。
 * @param {number} [request.pageSize] 每页条数。
 * @param {string} [request.query] 关键词，空串表示不过滤。
 * @param {object[]} [request.criterion] 筛选条件（分类 / 服务类型等），结构由广场定义。
 * @param {AbortSignal} [request.signal] 调用方取消信号。
 * @param {number} [request.timeoutMs] 单次请求超时。
 * @returns {Promise<{ servers: object[], totalCount: number, categoryAgg: object[] }>}
 */
export async function fetchPage(request = {}) {
  const {
    pageNumber = 1,
    pageSize = DEFAULT_PAGE_SIZE,
    query = "",
    criterion = [],
    signal,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = request;

  const payload = {
    PageSize: clampPageSize(pageSize),
    PageNumber: Math.max(1, Math.trunc(pageNumber)),
    Query: typeof query === "string" ? query : "",
    Criterion: Array.isArray(criterion) ? criterion : [],
  };

  const json = await requestJson(LIST_ENDPOINT, { method: "PUT", body: payload, signal, timeoutMs });

  const servers = Array.isArray(json?.Data?.McpServer?.McpServers) ? json.Data.McpServer.McpServers : [];
  const totalCount = Number(json?.Data?.McpServer?.TotalCount) || 0;
  const categoryAgg = Array.isArray(json?.Data?.FiledAgg?.Category) ? json.Data.FiledAgg.Category : [];

  return { servers, totalCount, categoryAgg };
}

/**
 * 分页拉取全量（「收集 / 扫描」用）。
 *
 * 广场现有 1.2 万+ 条，因此默认带页间隔以减轻对方压力，并支持页数上限与中途取消。
 *
 * @param {object} [options]
 * @param {number} [options.pageSize] 每页条数。
 * @param {number} [options.maxPages] 页数上限；不传表示拉到 totalCount 为止。
 * @param {number} [options.pageDelayMs] 页间隔，默认 120ms。
 * @param {(progress: {pageNumber: number, fetched: number, totalCount: number}) => void} [options.onProgress]
 * @param {AbortSignal} [options.signal]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{ servers: object[], totalCount: number, categoryAgg: object[], truncated: boolean }>}
 */
export async function fetchAll(options = {}) {
  const {
    pageSize = MAX_PAGE_SIZE,
    maxPages,
    pageDelayMs = 120,
    onProgress,
    signal,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options;

  const servers = [];
  let categoryAgg = [];
  let totalCount = 0;
  let pageNumber = 1;
  let truncated = false;

  for (;;) {
    if (signal?.aborted) break;

    const page = await fetchPage({ pageNumber, pageSize, signal, timeoutMs });
    if (pageNumber === 1) {
      totalCount = page.totalCount;
      categoryAgg = page.categoryAgg;
    }
    servers.push(...page.servers);
    onProgress?.({ pageNumber, fetched: servers.length, totalCount });

    const reachedServerCount = page.servers.length === 0 || servers.length >= totalCount;
    const reachedPageCap = typeof maxPages === "number" && pageNumber >= maxPages;
    // 匿名配额：还没取满 totalCount 就已经到不了下一页，也算被截断。
    const reachedAnonLimit = pageNumber * pageSize >= ANON_OFFSET_LIMIT;
    if (reachedServerCount || reachedPageCap) {
      truncated = (reachedPageCap || reachedAnonLimit) && servers.length < totalCount;
      break;
    }

    pageNumber += 1;
    if (pageDelayMs > 0) await delay(pageDelayMs);
  }

  return { servers, totalCount, categoryAgg, truncated };
}

/**
 * 匿名请求的偏移硬上限。
 *
 * 实测（2026-09）：无论 PageSize 取多少，只要 `(PageNumber - 1) * PageSize >= 300`
 * 就返回空列表且 TotalCount 归零。101 组组合（10/20/30/50/100 页宽 × 多页码）
 * 都精确卡在 300，所以这不是分页参数写错，而是服务端的匿名配额。
 *
 * 结论：单条查询最多只能拿到 300 条。想覆盖全量 1.2 万条，必须换关键词做扇出 ——
 * 见 `fetchByKeywords`。
 */
export const ANON_OFFSET_LIMIT = 300;

/** 关键词扇出的默认词表：单字母 + 单数字。实测这一层就贡献了绝大部分覆盖。 */
const SEED_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789".split("");

/**
 * 常见词补充表。单字母覆盖不到的词根（尤其多词命名的服务）靠它补齐。
 * 不是"必须命中"的过滤条件，多几个词只是多几次请求。
 */
const SEED_TERMS = [
  "mcp", "server", "api", "tool", "data", "file", "web", "code", "search", "db",
  "sql", "cloud", "ai", "llm", "agent", "google", "github", "slack", "notion", "aws",
  "docker", "k8s", "browser", "fetch", "map", "weather", "news", "stock", "finance", "email",
  "bilibili", "weibo", "zhihu", "taobao", "aliyun", "tencent", "baidu", "amap", "wechat", "douyin",
  "翻译", "搜索", "天气", "地图", "数据库", "文档", "视频", "音乐", "图片", "新闻",
];

/**
 * 组装扇出用的关键词种子。
 *
 * @param {object[]} [categories] 首屏 FiledAgg 里的分类聚合，取 Value 作为额外关键词。
 * @param {object} [options]
 * @param {number} [options.maxKeywords] 词表上限，防止无限膨胀。
 * @returns {string[]} 去重后的关键词列表（保留顺序）。
 */
export function buildKeywordSeed(categories, options = {}) {
  const fromCategories = (Array.isArray(categories) ? categories : [])
    .map((item) => (item && typeof item.Value === "string" ? item.Value.trim() : ""))
    .filter(Boolean);

  const all = [...SEED_ALPHABET, ...SEED_TERMS, ...fromCategories];
  const unique = [];
  const seen = new Set();
  for (const raw of all) {
    const key = raw.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(raw);
    if (typeof options.maxKeywords === "number" && unique.length >= options.maxKeywords) break;
  }
  return unique;
}

/**
 * 关键词扇出抓取：对每个关键词独立翻页，最后按记录 id 去重合并。
 *
 * 为什么要这样：匿名配额把单条查询锁死在 300 条，只有换关键词才能看到不同切片。
 * 实测（2026-09，广场总量 12,520）：
 *   36 个字母数字 → 7,132 条（57.0%）
 *   80 个词      → 8,331 条（66.6%）
 *  160 个词      → 8,403 条（67.1%）
 * 收益集中在前面，所以上游默认把词表收在 96（见 market/gateway.js 的注释）。
 *
 * 单个关键词失败不会中断整体 —— 记进 `failedKeywords` 继续下一个，
 * 避免一个词抖动就让整次同步白跑。
 *
 * @param {object} [options]
 * @param {string[]} [options.keywords] 关键词列表；不传则用 `buildKeywordSeed()`。
 * @param {number} [options.pageSize] 每页条数。
 * @param {number} [options.maxPagesPerKeyword] 每个关键词最多翻几页（默认 3，正好吃满匿名配额）。
 * @param {number} [options.maxRequests] 全局请求上限，硬性刹车。
 * @param {number} [options.pageDelayMs] 请求间隔。
 * @param {(progress: {keyword: string, index: number, total: number, fetched: number, requests: number}) => void} [options.onProgress]
 * @param {AbortSignal} [options.signal]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{servers: object[], totalCount: number, categoryAgg: object[], requests: number, keywords: number, failedKeywords: string[]}>}
 */
export async function fetchByKeywords(options = {}) {
  const {
    keywords,
    pageSize = MAX_PAGE_SIZE,
    maxPagesPerKeyword = 3,
    maxRequests = 400,
    pageDelayMs = 120,
    onProgress,
    signal,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options;

  const seedInput = Array.isArray(keywords) && keywords.length > 0 ? keywords : buildKeywordSeed();
  // 先跑一次空关键词：它返回真实总量与分类聚合（关键词查询的 TotalCount 是命中数），
  // 顺带把配额内的头 300 条一次收下。放在最前面还能让后面的归类逻辑省掉一次补请求。
  const seed = seedInput.includes("") ? seedInput : ["", ...seedInput];
  const merged = new Map();
  const failedKeywords = [];
  let totalCount = 0;
  let categoryAgg = [];
  let requests = 0;

  const keyOf = (server) => {
    const id = server?.Id;
    if (id !== undefined && id !== null && String(id) !== "") return String(id);
    return `${server?.Publisher ?? ""}/${server?.Name ?? ""}/${server?.Path ?? ""}`;
  };

  for (let index = 0; index < seed.length; index += 1) {
    if (signal?.aborted) break;
    if (requests >= maxRequests) break;

    const keyword = seed[index];
    let fetchedForKeyword = 0;

    for (let pageNumber = 1; pageNumber <= maxPagesPerKeyword; pageNumber += 1) {
      if (signal?.aborted || requests >= maxRequests) break;
      let page;
      try {
        page = await fetchPage({ pageNumber, pageSize, query: keyword, signal, timeoutMs });
        requests += 1;
      } catch (error) {
        if (error?.name === "AbortError" || signal?.aborted) break;
        failedKeywords.push(keyword);
        break;
      }

      if (pageNumber === 1) {
        // 只有空关键词那次返回的是「全局」总量与分类聚合；关键词查询的 TotalCount
        // 和 FiledAgg 都是该词的命中范围（用它会把分类计数写成个位数）。
        if (keyword === "") {
          totalCount = page.totalCount;
          if (page.categoryAgg.length > 0) categoryAgg = page.categoryAgg;
        } else if (categoryAgg.length === 0 && page.categoryAgg.length > 0) {
          // 兜底：空关键词那次失败或没返回聚合时，至少拿到一份能用的。
          categoryAgg = page.categoryAgg;
        }
      }

      if (page.servers.length === 0) break;
      for (const server of page.servers) merged.set(keyOf(server), server);
      fetchedForKeyword += page.servers.length;

      // 词的命中数已吃满，或已经碰到匿名配额，就不必再翻。
      if (page.servers.length < pageSize) break;
      if (pageNumber * pageSize >= ANON_OFFSET_LIMIT) break;

      if (pageDelayMs > 0) await delay(pageDelayMs);
    }

    onProgress?.({ keyword, index: index + 1, total: seed.length, fetched: merged.size, requests });
    if (pageDelayMs > 0) await delay(pageDelayMs);
  }

  if (totalCount === 0 && requests < maxRequests) {
    // 兜底：词表被调用方裁掉了空串、或那次请求失败时，补一次拿总量与分类聚合。
    // 计入请求预算，绝不超发。
    try {
      const base = await fetchPage({ pageNumber: 1, pageSize: 1, query: "", signal, timeoutMs });
      requests += 1;
      totalCount = base.totalCount;
      if (categoryAgg.length === 0) categoryAgg = base.categoryAgg;
    } catch {
      // 拿不到总量不影响已抓到的数据。
    }
  }

  return {
    servers: [...merged.values()],
    totalCount,
    categoryAgg,
    requests,
    keywords: seed.length,
    failedKeywords,
  };
}

/**
 * 广场首页配置（banner、分类展示名等）。失败不致命，调用方自行降级。
 *
 * @param {object} [options]
 * @returns {Promise<object[]>} configs 数组；不可用时返回空数组。
 */
export async function fetchHomeConfig(options = {}) {
  try {
    const json = await requestJson(HOME_CONFIG_ENDPOINT, {
      method: "GET",
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    return Array.isArray(json?.Data?.configs) ? json.Data.configs : [];
  } catch {
    return [];
  }
}

/**
 * 发起请求并解析 JSON，带超时、重试与统一错误包装。
 */
async function requestJson(url, { method, body, signal, timeoutMs }) {
  let lastError;

  for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await delay(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));

    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

    try {
      const response = await fetch(url, {
        method,
        headers: {
          Accept: "application/json",
          "User-Agent": UA,
          Referer: `${ORIGIN}/mcp`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: combined,
      });

      if (!response.ok) {
        throw new MarketUnavailableError(`广场接口返回 HTTP ${response.status}`);
      }

      const json = await response.json();
      if (json && typeof json === "object" && json.Code !== undefined && json.Code !== 200) {
        throw new MarketUnavailableError(`广场接口返回 Code ${json.Code}${json.Message ? `：${json.Message}` : ""}`);
      }
      return json;
    } catch (error) {
      if (signal?.aborted) throw error;
      lastError = error;
    }
  }

  if (lastError instanceof MarketUnavailableError) throw lastError;
  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new MarketUnavailableError(`无法访问魔搭 MCP 广场：${detail}`, { cause: lastError });
}

function clampPageSize(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_PAGE_SIZE;
  return Math.min(Math.trunc(n), MAX_PAGE_SIZE);
}

/**
 * 把广场原始记录规整成插件内部结构。
 *
 * 广场字段很多且偶有缺失，这里只取用得到的，并统一成确定类型，
 * 让上层（转换器 / 列表 UI）不必反复做防御。
 *
 * @param {object} raw 广场返回的单条记录。
 * @returns {object} 规整后的记录。
 */
export function normalizeServer(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  return {
    id: toInt(source.Id),
    name: toText(source.Name),
    scope: toText(source.Path),
    publisher: toText(source.Publisher),
    chineseName: toText(source.ChineseName),
    abstract: toText(source.AbstractCN) || toText(source.Abstract) || toText(source.TranslatedAbstract),
    readme: toText(source.ReadmeCN) || toText(source.Readme) || toText(source.TranslatedReadme),
    hosted: source.Hosted === true,
    verified: source.Verifed === true,
    stars: toInt(source.Stars),
    views: toInt(source.ViewCount),
    callVolume: toInt(source.CallVolume),
    categories: toStringArray(source.Category),
    tags: toStringArray(source.Tags),
    license: toText(source.License),
    fromSiteUrl: toText(source.FromSiteUrl),
    supportedTransports: toStringArray(source.SupportedDeployTransportType),
    deployedUrl: toText(source.DeployedUrl),
    deployedUrlTransport: toText(source.DeployedUrlTransportType),
    serverConfig: normalizeMcpConfigList(source.ServerConfig),
    streamableHttpConfig: normalizeMcpConfigList(source.StreamableHTTPServerConfig),
    sseConfig: normalizeMcpConfigList(source.SSEServerConfig),
    envSchema: normalizeEnvSchema(source.EnvSchema),
    tools: normalizeTools(source.Tools),
    createdAt: toInt(source.GmtCreated),
    updatedAt: toInt(source.GmtUpdated),
    detailPath: toText(source.Publisher) ? `/mcp/servers/${toText(source.Publisher)}` : "",
  };
}

/** 详情页 URL（用于「在魔搭查看」）。 */
export function detailUrlOf(server) {
  if (!server || typeof server.publisher !== "string" || server.publisher === "") return `${ORIGIN}/mcp`;
  return `${ORIGIN}/mcp/servers/${server.publisher}`;
}

function normalizeMcpConfigList(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const servers = entry.mcpServers;
    if (!servers || typeof servers !== "object") continue;
    for (const [name, config] of Object.entries(servers)) {
      if (!config || typeof config !== "object") continue;
      out.push({ name: toText(name) || "server", ...config });
    }
  }
  return out;
}

function normalizeEnvSchema(value) {
  const source = value && typeof value === "object" ? value : {};
  const properties = source.properties && typeof source.properties === "object" ? source.properties : {};
  const required = toStringArray(source.required);
  const fields = Object.entries(properties).map(([key, spec]) => {
    const detail = spec && typeof spec === "object" ? spec : {};
    return {
      key,
      type: toText(detail.type) || "string",
      description: toText(detail.description),
      example: detail.test_value === undefined ? "" : String(detail.test_value),
      required: required.includes(key),
    };
  });
  return { fields, hasRequired: fields.some((field) => field.required) };
}

function normalizeTools(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((tool) => {
      if (!tool || typeof tool !== "object") return undefined;
      return {
        name: toText(tool.Name ?? tool.name),
        description: toText(tool.Description ?? tool.description),
      };
    })
    .filter((tool) => tool !== undefined);
}

function toText(value) {
  return typeof value === "string" ? value : "";
}

function toInt(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function toStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === "string" && item !== "");
}

export { ORIGIN as MODELSCOPE_ORIGIN, LIST_ENDPOINT, HOME_CONFIG_ENDPOINT };
