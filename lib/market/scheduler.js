/**
 * 广场索引的定时同步。
 *
 * 用户要的是「可以手动刷新，也可以设置定时同步」，所以这里做两件事：
 *   1. 启动补同步 —— 缓存缺失或已过期时，开机后自动拉一次，让面板一打开就有数据；
 *   2. 周期性同步 —— 按 `intervalHours` 重复拉取，保持索引新鲜。
 *
 * 定时器用全局 setInterval + ctx.effect 注册，fiber 销毁时自动清理 ——
 * 这样不依赖 `@deepseek-ai/cordis-plugin-timer`（虽然 dsh-base 默认会装，
 * 但本插件不假设它一定在），也不需要往 inject 里加服务。
 *
 * 这里不自己发请求，一律走 MarketGateway.sync()，与手动同步共用同一份
 * in-flight 保护，因此「用户刚点了立即同步、定时器又到点」不会重复拉取。
 */

import { DEFAULT_TTL_MS, isFresh, readCache } from "./cache.js";

/** 定时同步的可调项与默认值。 */
export const DEFAULT_SCHEDULE = {
  /** 是否开启周期性同步。 */
  autoSync: true,
  /** 周期长度（小时）。 */
  intervalHours: 24,
  /** 启动后若缓存缺失/过期则补一次同步。 */
  syncOnStart: true,
  /** 启动补同步的延迟，给宿主其它插件让出启动带宽。 */
  startDelayMs: 15000,
  /**
   * 单次同步的请求预算。
   *
   * 匿名配额把单条查询锁在 300 条，同步靠关键词扇出，所以预算按请求数算：
   * 实测 36 个字母数字（约 100 次请求）能覆盖 7132 / 12520；加上常用词与
   * 分类词，400 次请求约 3~5 分钟。
   */
  maxRequests: 400,
};

/** 周期下限 15 分钟 —— 再密就没有意义，只会给对方添麻烦。 */
export const MIN_INTERVAL_HOURS = 0.25;

/**
 * 周期上限 7 天。
 * Node 的定时器以 32 位有符号整数存毫秒，超过 2^31-1（约 24.8 天）会触发
 * TimeoutOverflowWarning 并退化成 1ms 轮询，所以这里必须收在安全区内。
 */
export const MAX_INTERVAL_HOURS = 24 * 7;

const MAX_SAFE_DELAY_MS = 2 ** 31 - 1;

/**
 * 把插件 config 规整成可用的调度参数。非法的值一律回退到默认值，
 * 而不是抛错 —— 配置写错不该让整个插件起不来。
 *
 * @param {object} [config] cordis.patch.yml 里该行的 config 块。
 * @returns {typeof DEFAULT_SCHEDULE}
 */
export function normalizeSchedule(config) {
  const source = config && typeof config === "object" ? config : {};
  return {
    autoSync: source.autoSync === undefined ? DEFAULT_SCHEDULE.autoSync : source.autoSync === true,
    intervalHours: clampInterval(source.intervalHours, DEFAULT_SCHEDULE.intervalHours),
    syncOnStart: source.syncOnStart === undefined ? DEFAULT_SCHEDULE.syncOnStart : source.syncOnStart === true,
    startDelayMs: clampDelay(source.startDelayMs, DEFAULT_SCHEDULE.startDelayMs),
    maxRequests: clampRequests(source.maxRequests, DEFAULT_SCHEDULE.maxRequests),
  };
}

function clampInterval(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.max(n, MIN_INTERVAL_HOURS), MAX_INTERVAL_HOURS);
}

function clampDelay(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(Math.trunc(n), 10 * 60 * 1000);
}

function clampRequests(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.trunc(n), 2000);
}

/**
 * 周期性同步的执行器。
 *
 * 生命周期由 `start()` 里注册的 effect 决定：插件被卸载或 HMR 重载时，
 * 已排定的定时器会随之清掉，不会留下野生的后台任务。
 */
export class MarketScheduler {
  /**
   * @param {object} options
   * @param {object} options.ctx cordis 上下文。
   * @param {{sync: (payload?: object) => Promise<object>}} options.market 广场服务。
   * @param {typeof DEFAULT_SCHEDULE} options.options 规整后的调度参数。
   */
  constructor({ ctx, market, options }) {
    this.ctx = ctx;
    this.market = market;
    this.options = options;
    /** 内存中的运行状态；持久化的那份写在缓存的 lastSync 里。 */
    this.lastRunAt = 0;
    this.lastResult = undefined;
    this.lastError = "";
    this.nextRunAt = 0;
    this.running = false;
    this.started = false;
  }

  /** 供面板展示的调度状态（纯数据，可安全过 wire）。 */
  get state() {
    const { autoSync, intervalHours, syncOnStart, startDelayMs } = this.options;
    return {
      autoSync,
      intervalHours,
      intervalMs: Math.round(intervalHours * 3600 * 1000),
      syncOnStart,
      startDelayMs,
      running: this.running,
      started: this.started,
      lastRunAt: this.lastRunAt,
      lastError: this.lastError,
      lastResult: this.lastResult,
      nextRunAt: this.nextRunAt,
      ttlMs: DEFAULT_TTL_MS,
    };
  }

  /**
   * 注册定时器与启动补同步。重复调用无副作用。
   */
  start() {
    if (this.started) return;
    this.started = true;

    if (this.options.autoSync) {
      const intervalMs = Math.min(Math.round(this.options.intervalHours * 3600 * 1000), MAX_SAFE_DELAY_MS);
      this.nextRunAt = Date.now() + intervalMs;
      this.ctx.effect(() => {
        const timer = setInterval(() => {
          this.nextRunAt = Date.now() + intervalMs;
          void this.run("auto");
        }, intervalMs);
        // 后台定时器不该拖住进程退出。
        timer.unref?.();
        return () => clearInterval(timer);
      }, "dsh-mcp-market: 定时同步");
      this.log("info", `定时同步已开启，每 ${this.options.intervalHours} 小时一次`);
    } else {
      this.nextRunAt = 0;
      this.log("info", "定时同步未开启（config.autoSync = false）");
    }

    if (this.options.syncOnStart) {
      const timer = setTimeout(() => {
        void this.runStartup();
      }, this.options.startDelayMs);
      timer.unref?.();
      this.ctx.effect(() => () => clearTimeout(timer), "dsh-mcp-market: 启动同步");
    }
  }

  /** 启动补同步：只在缓存确实缺失或过期时才真的拉。 */
  async runStartup() {
    try {
      const cache = await readCache();
      if (isFresh(cache)) {
        this.log("info", "缓存仍然新鲜，跳过启动同步");
        return;
      }
      this.log("info", cache ? "缓存已过期，启动补同步" : "本地无缓存，启动补同步");
      await this.run("startup");
    } catch (error) {
      this.recordError(error, "startup");
    }
  }

  /**
   * 执行一次同步。并发调用会共享同一次运行（靠 market.sync 自身的保护）。
   *
   * @param {"manual" | "auto" | "startup"} trigger 触发来源。
   * @returns {Promise<object|undefined>} 同步结果；失败时返回 undefined。
   */
  async run(trigger) {
    if (this.running) return undefined;
    this.running = true;
    try {
      const result = await this.market.sync({ maxRequests: this.options.maxRequests, trigger });
      this.lastRunAt = Date.now();
      this.lastResult = result;
      this.lastError = "";
      this.log("info", `同步完成（${trigger}）：新增 ${result.added}、更新 ${result.updated}、下架 ${result.removed}`);
      return result;
    } catch (error) {
      this.recordError(error, trigger);
      return undefined;
    } finally {
      this.running = false;
    }
  }

  recordError(error, trigger) {
    this.lastRunAt = Date.now();
    this.lastError = error instanceof Error ? error.message : String(error);
    this.log("warn", `同步失败（${trigger}）：${this.lastError}`);
  }

  log(level, message) {
    const logger = this.ctx?.logger;
    const fn = logger?.[level];
    if (typeof fn !== "function") return;
    try {
      fn.call(logger, `[dsh-mcp-market] ${message}`);
    } catch {
      // 宿主 logger 形态变化不该影响同步本身。
    }
  }
}
