/**
 * mcpMarket —— 广场数据服务（host 侧）。
 *
 * 职责：把魔搭广场的数据变成面板能直接用的东西 ——
 *   - 搜索 / 分类：实时查询广场（不依赖缓存，保证新鲜）
 *   - 同步：全量扫描落「精简索引」缓存，并用 GmtUpdated 做增量比对
 *   - 方案：把某条广场记录翻译成一份可写入 patch 的 DSH 配置
 *
 * 缓存只存列表展示所需字段（readme、工具清单等大字段不落盘），
 * 否则 1.2 万条的完整记录会让缓存文件膨胀到几十 MB。
 */

import { TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { MAX_PAGE_SIZE, buildKeywordSeed, fetchByKeywords, fetchPage, normalizeServer, detailUrlOf } from "../modelscope/client.js";
import { DEFAULT_TTL_MS, cacheFilePath, isFresh, readCache, writeCache } from "./cache.js";
import { diffServers } from "./sync.js";
import { filterEntries, sortEntries } from "./filter.js";
import { listMcpPatchRows, readPatchFile } from "../mcp/patch-editor.js";
import { profilePatchPath } from "../mcp/paths.js";
import { configFromPatchRow } from "../mcp/model.js";
import { buildInstallPlan, displayNameOf, resolveInstallKind } from "./convert.js";

/** 单次搜索返回上限，避免前端一次拿到过多数据。 */
const SEARCH_PAGE_SIZE = 30;

/**
 * 全量同步的请求预算。
 *
 * 匿名配额把单条查询锁在 300 条，所以同步靠关键词扇出（词表见
 * modelscope/client.js 的 SEED_ALPHABET / SEED_TERMS）。
 *
 * 实测（2026-09，广场总量 12,520）：
 *   36 个字母数字 → 7,132 条（57.0%），100 次请求
 *   80 个词      → 8,331 条（66.6%），约 155 次请求
 *  160 个词      → 8,403 条（67.1%），236 次请求
 * 后 80 个词（基本都是分类词）只多贡献 72 条，性价比极低。
 * 所以默认词表收到 96，请求预算留 400 作为上限，实际跑不满。
 */
const SYNC_MAX_REQUESTS = 400;

/** 词表上限。96 ≈ 36 个字母数字 + 50 个常用词 + 少量分类词，实测性价比拐点。 */
const SYNC_MAX_KEYWORDS = 96;

/** 每个关键词翻几页；3 页 × 100 条正好吃满匿名配额，再多也是空。 */
const SYNC_PAGES_PER_KEYWORD = 3;

export class MarketGateway extends TypertRemoteService {
  constructor(ctx, scheduler) {
    super(ctx, "mcpMarket");
    /** 定时同步执行器；由 index.js 注入，用于在 status 里回报调度状态。 */
    this.scheduler = scheduler;
    /** 进行中的同步；并发调用共享同一次运行，避免重复全量拉取。 */
    this.pendingSync = undefined;
  }

  get C() {
    return this.ctx;
  }

  /**
   * 缓存状态：文件位置、条数、时间、新鲜度，以及定时同步的当前调度。
   */
  async status() {
    const cache = await readCache();
    const cachedCount = Array.isArray(cache?.servers) ? cache.servers.length : 0;
    const totalCount = cache?.totalCount ?? 0;
    return {
      cachePath: cacheFilePath(),
      totalCount,
      cachedCount,
      // 匿名配额决定了索引拿不满全量，这里如实给出覆盖率供面板提示。
      coverage: totalCount > 0 ? cachedCount / totalCount : 0,
      fetchedAt: cache?.fetchedAt ?? 0,
      fresh: isFresh(cache),
      ttlMs: DEFAULT_TTL_MS,
      lastSync: cache?.lastSync ?? undefined,
      schedule: this.scheduler?.state ?? { autoSync: false, started: false, ttlMs: DEFAULT_TTL_MS },
      source: "https://modelscope.cn/mcp",
    };
  }

  /**
   * 实时搜索广场。
   *
   * @param {object} payload
   * @param {string} [payload.query] 关键词。
   * @param {number} [payload.pageNumber]
   * @param {number} [payload.pageSize]
   * @param {object[]} [payload.criterion] 广场筛选条件。
   */
  async search(payload = {}) {
    const installed = await this.installedNames();
    const query = typeof payload.query === "string" ? payload.query.trim() : "";
    const category = typeof payload.category === "string" ? payload.category.trim() : "";
    const hosted = typeof payload.hosted === "boolean" ? payload.hosted : undefined;
    const sort = typeof payload.sort === "string" ? payload.sort : "relevance";
    const pageNumber = Math.max(1, Number(payload.pageNumber) || 1);
    const pageSize = clampSize(payload.pageSize);

    const cache = payload.source === "live" ? undefined : await readCache();
    const hasCache = Boolean(cache && Array.isArray(cache.servers) && cache.servers.length > 0);

    // 有缓存时一律走本地筛选：广场的 Criterion 参数格式未公开（实测各种形态都被忽略），
    // 分类筛选只能在本地做；顺带也让翻页不再打网络。
    if (hasCache) {
      const localHits = sortEntries(filterEntries(cache.servers, { query, category, hosted }), sort);
      const start = (pageNumber - 1) * pageSize;

      // 关键词搜索补一次实时查询。
      //
      // 匿名配额（见 client.js 的 ANON_OFFSET_LIMIT）决定了本地索引只能覆盖全量的
      // 一部分，光靠本地筛会漏掉没被索引到的服务。好在 `Query` 是接口原生支持的
      // 关键词搜索，能覆盖索引之外。只在「有查询词 + 没加本地才有的筛选 + 本地命中
      // 不足一页 + 首页」时才补，避免用户每敲一个字都打网络。
      const shouldSupplement =
        query !== "" && category === "" && hosted === undefined && pageNumber === 1 && localHits.length < pageSize;

      if (!shouldSupplement) {
        return {
          servers: localHits.slice(start, start + pageSize).map((entry) => this.cachedToCard(entry, installed)),
          totalCount: localHits.length,
          categories: cache.categories ?? [],
          source: "cache",
          cachedAt: cache.fetchedAt ?? 0,
        };
      }

      let liveCards = [];
      try {
        const page = await fetchPage({ query, pageNumber: 1, pageSize: MAX_PAGE_SIZE });
        liveCards = page.servers.map((raw) => this.toCard(normalizeServer(raw), installed));
      } catch {
        // 实时查询失败不该让本地结果也拿不到，降级成纯本地。
        liveCards = [];
      }

      // 实时命中更精确，排在前面；本地命中补齐，按 publisher 去重。
      const merged = [];
      const seen = new Set();
      for (const card of liveCards) {
        if (seen.has(card.publisher)) continue;
        seen.add(card.publisher);
        merged.push(card);
      }
      for (const entry of localHits) {
        if (seen.has(entry.publisher)) continue;
        seen.add(entry.publisher);
        merged.push(this.cachedToCard(entry, installed));
      }

      return {
        servers: merged.slice(start, start + pageSize),
        totalCount: merged.length,
        categories: cache.categories ?? [],
        source: liveCards.length > 0 ? "cache+live" : "cache",
        cachedAt: cache.fetchedAt ?? 0,
      };
    }

    const page = await fetchPage({ query, pageNumber, pageSize });
    return {
      servers: page.servers.map((raw) => this.toCard(normalizeServer(raw), installed)),
      totalCount: page.totalCount,
      categories: page.categoryAgg,
      source: "live",
      cachedAt: 0,
    };
  }

  /**
   * 分类聚合（用于筛选栏）。走一次空查询即可拿到。
   */
  async categories() {
    const page = await fetchPage({ pageSize: 1, pageNumber: 1 });
    return { categories: page.categoryAgg, totalCount: page.totalCount };
  }

  /**
   * 全量同步：拉取全部记录 → 与缓存比对 → 写回精简索引。
   *
   * 并发调用共享同一次运行：手动「立即同步」与定时任务撞车时不会拉两遍。
   *
   * @param {object} [payload]
   * @param {number} [payload.maxPages] 页数上限，便于快速试跑。
   * @param {boolean} [payload.allowEmpty] 允许把空结果写回缓存（默认不允许，防误清）。
   * @param {"manual"|"auto"|"startup"} [payload.trigger] 触发来源，仅用于记录。
   * @param {number} [payload.maxRequests] 本次同步的请求上限（保护广场服务）。
   * @param {number} [payload.maxKeywords] 关键词词表上限。
   * @param {number} [payload.pagesPerKeyword] 每个关键词翻几页，默认 3（正好吃满匿名配额）。
   * @param {boolean} [payload.allowEmpty] 允许把空结果写回缓存（默认不允许，防误清）。
   */
  async sync(payload = {}) {
    if (this.pendingSync) return this.pendingSync;

    const run = this.runSync(payload).finally(() => {
      this.pendingSync = undefined;
    });
    this.pendingSync = run;
    return run;
  }

  /** @private sync 的实际执行体（不含并发保护）。 */
  async runSync(payload = {}) {
    const previous = await readCache();
    const started = Date.now();
    const trigger = normalizeTrigger(payload.trigger);

    // 匿名配额把单条查询锁在 300 条，所以走关键词扇出。
    // 词表 = 单字母/数字 + 常用词 + 上次缓存里的分类，全部命中不同切片。
    const keywords = buildKeywordSeed(previous?.categories, {
      maxKeywords: Number(payload.maxKeywords) > 0 ? Number(payload.maxKeywords) : SYNC_MAX_KEYWORDS,
    });

    const result = await fetchByKeywords({
      keywords,
      pageSize: MAX_PAGE_SIZE,
      maxPagesPerKeyword:
        Number(payload.pagesPerKeyword) > 0 ? Number(payload.pagesPerKeyword) : SYNC_PAGES_PER_KEYWORD,
      maxRequests: Number(payload.maxRequests) > 0 ? Number(payload.maxRequests) : SYNC_MAX_REQUESTS,
      onProgress: (progress) => {
        this.syncProgress = progress;
      },
    });
    this.syncProgress = undefined;

    if (result.servers.length === 0 && payload.allowEmpty !== true) {
      throw new Error("本次同步未取到任何数据，已放弃写入，避免清空既有缓存");
    }

    const nextServers = result.servers.map((raw) => toIndexEntry(normalizeServer(raw)));
    const diff = diffServers(previous?.servers ?? [], nextServers);
    const finishedAt = Date.now();
    const totalCount = result.totalCount > 0 ? result.totalCount : nextServers.length;

    await writeCache({
      servers: nextServers,
      categories: result.categoryAgg,
      totalCount,
      lastSync: {
        at: finishedAt,
        trigger,
        added: diff.added.length,
        updated: diff.updated.length,
        removed: diff.removed.length,
        scanned: nextServers.length,
        totalCount,
        coverage: totalCount > 0 ? nextServers.length / totalCount : 0,
        requests: result.requests,
        elapsedMs: finishedAt - started,
      },
    });

    return {
      added: diff.added.length,
      updated: diff.updated.length,
      removed: diff.removed.length,
      unchanged: diff.unchanged,
      addedList: diff.added.slice(0, 50).map(toBrief),
      updatedList: diff.updated.slice(0, 50).map(toBrief),
      totalCount,
      scanned: nextServers.length,
      // 匿名配额决定了拿不满全量，这里如实报告覆盖率而不是假装完成了。
      coverage: totalCount > 0 ? nextServers.length / totalCount : 0,
      requests: result.requests,
      keywords: result.keywords,
      failedKeywords: result.failedKeywords.slice(0, 10),
      partial: nextServers.length < totalCount,
      elapsedMs: finishedAt - started,
      fetchedAt: finishedAt,
      trigger,
    };
  }

  /**
   * 为某条广场记录生成安装方案。
   *
   * @param {object} payload
   * @param {string} payload.publisher 记录标识（scope/name）。
   * @param {string} [payload.serverName] 指定 serverName。
   * @param {Record<string,string>} [payload.env] 用户填写的环境变量。
   * @param {boolean} [payload.preferLocal] 优先用本地命令方式。
   */
  async plan(payload = {}) {
    const record = await this.lookup(payload.publisher);
    if (record === undefined) {
      return { ok: false, reason: "未在广场找到该服务（可能已下架，请刷新后重试）" };
    }

    const installed = await this.installedNames();
    const plan = buildInstallPlan(record, {
      serverName: typeof payload.serverName === "string" ? payload.serverName : undefined,
      taken: installed,
      preferLocal: payload.preferLocal === true,
      env: sanitizeEnv(payload.env),
    });

    return {
      ...plan,
      publisher: record.publisher,
      displayName: displayNameOf(record),
      detailUrl: detailUrlOf(record),
      toolCount: Array.isArray(record.tools) ? record.tools.length : 0,
      tools: Array.isArray(record.tools) ? record.tools.slice(0, 50) : [],
      envFields: plan.envFields ?? record.envSchema?.fields ?? [],
    };
  }

  /**
   * 服务详情（说明文本、工具清单、支持的方式）。
   */
  async detail(payload = {}) {
    const record = await this.lookup(payload.publisher);
    if (record === undefined) return undefined;
    const installed = await this.installedNames();
    const { kind, reason } = resolveInstallKind(record);
    return {
      ...this.toCard(record, installed),
      readme: record.readme.slice(0, 20000),
      tools: record.tools.slice(0, 200),
      envFields: record.envSchema?.fields ?? [],
      installKind: kind,
      installReason: reason,
      supportedTransports: record.supportedTransports,
      detailUrl: detailUrlOf(record),
    };
  }

  /**
   * 按 publisher 精确取一条完整记录：用关键词查询缩小范围后再精确匹配。
   */
  async lookup(publisher) {
    const key = typeof publisher === "string" ? publisher.trim() : "";
    if (key === "") return undefined;

    // 先用 publisher 的末段（通常是服务名）作为关键词，命中率最高。
    const keyword = key.includes("/") ? key.slice(key.lastIndexOf("/") + 1) : key;
    for (const query of [keyword, key]) {
      const page = await fetchPage({ query, pageSize: 100, pageNumber: 1 });
      const hit = page.servers.map(normalizeServer).find((server) => server.publisher === key);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }

  /** 卡片视图：列表展示所需字段 + 安装可行性标记。 */
  toCard(server, installed) {
    const { kind, reason } = resolveInstallKind(server);
    return {
      publisher: server.publisher,
      name: server.name,
      chineseName: server.chineseName,
      displayName: displayNameOf(server),
      abstract: server.abstract,
      hosted: server.hosted,
      verified: server.verified,
      stars: server.stars,
      views: server.views,
      callVolume: server.callVolume,
      categories: server.categories,
      tags: server.tags,
      license: server.license,
      updatedAt: server.updatedAt,
      toolCount: Array.isArray(server.tools) ? server.tools.length : 0,
      installKind: kind,
      installReason: reason,
      requiresEnv: server.envSchema?.hasRequired === true,
      envFieldCount: Array.isArray(server.envSchema?.fields) ? server.envSchema.fields.length : 0,
      installed: installed.has(server.name) || installed.has(server.publisher),
      detailUrl: detailUrlOf(server),
    };
  }

  /** 缓存条目 → 卡片视图（判断结果已在入库时算好）。 */
  cachedToCard(entry, installed) {
    return {
      publisher: entry.publisher,
      name: entry.name,
      chineseName: entry.chineseName,
      displayName: displayNameOf(entry),
      abstract: entry.abstract,
      hosted: entry.hosted === true,
      verified: entry.verified === true,
      stars: entry.stars ?? 0,
      views: entry.views ?? 0,
      callVolume: entry.callVolume ?? 0,
      categories: entry.categories ?? [],
      tags: entry.tags ?? [],
      license: entry.license ?? "",
      updatedAt: entry.updatedAt ?? 0,
      toolCount: entry.toolCount ?? 0,
      installKind: entry.installKind ?? "unsupported",
      installReason: "",
      requiresEnv: entry.requiresEnv === true,
      envFieldCount: entry.envFieldCount ?? 0,
      installed: installed.has(entry.name) || installed.has(entry.publisher),
      detailUrl: detailUrlOf(entry),
    };
  }

  /** 当前 patch 中已安装的 serverName 集合。 */
  async installedNames() {
    const names = new Set();
    try {
      const raw = await readPatchFile(profilePatchPath(this.C));
      for (const row of listMcpPatchRows(raw)) {
        const config = configFromPatchRow(row);
        if (typeof config?.serverName === "string") names.add(config.serverName);
      }
    } catch {
      // patch 不可读：视为「什么都没装」，不阻断广场浏览。
    }
    return names;
  }

}

/**
 * 缓存用的精简条目：去掉 readme / 工具清单等大字段（1.2 万条会撑到几十 MB），
 * 但把列表展示与筛选要用的判断结果预先算好 —— 这样前端渲染卡片不必回源。
 */
function toIndexEntry(server) {
  const { kind } = resolveInstallKind(server);
  return {
    id: server.id,
    name: server.name,
    scope: server.scope,
    publisher: server.publisher,
    chineseName: server.chineseName,
    abstract: server.abstract.slice(0, 160),
    hosted: server.hosted,
    verified: server.verified,
    stars: server.stars,
    views: server.views,
    callVolume: server.callVolume,
    categories: server.categories,
    tags: server.tags,
    license: server.license,
    updatedAt: server.updatedAt,
    installKind: kind,
    requiresEnv: server.envSchema?.hasRequired === true,
    envFieldCount: Array.isArray(server.envSchema?.fields) ? server.envSchema.fields.length : 0,
    toolCount: Array.isArray(server.tools) ? server.tools.length : 0,
    configFingerprint: fingerprintOf(server),
  };
}

/** 按关键词 / 分类 / 托管类型过滤缓存条目。 */

/** 连接配置的指纹，用于「时间戳没变但配置变了」的情况。 */
function fingerprintOf(server) {
  return JSON.stringify({
    local: (server.serverConfig ?? []).map((entry) => [entry.command, entry.args ?? []]),
    remote: (server.streamableHttpConfig ?? []).map((entry) => entry.url),
  });
}

function toBrief(server) {
  return {
    publisher: server.publisher,
    displayName: displayNameOf(server),
    updatedAt: server.updatedAt,
  };
}

function clampSize(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return SEARCH_PAGE_SIZE;
  return Math.min(Math.trunc(n), 100);
}

/** 触发来源白名单；未知值一律当手动。 */
function normalizeTrigger(value) {
  return value === "auto" || value === "startup" ? value : "manual";
}

function sanitizeEnv(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string" && item !== "") out[key] = item;
  }
  return out;
}
