/**
 * 广场数据的本地缓存。
 *
 * 缓存让面板在广场不可用时仍能展示上次结果，也是「增量同步」的比对基准。
 * 写入走同目录临时文件 + rename，避免中途失败留下半个文件。
 */

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";

/** 缓存结构版本；结构变化时递增，旧缓存会被视为无效并重建。 */
export const CACHE_VERSION = 1;

/** 缓存所在目录（相对 DSH_HOME）。 */
const CACHE_DIR_NAME = "mcp-market";
const CACHE_FILE_NAME = "market-cache.json";

/** 缓存新鲜度阈值：默认 6 小时内不重复全量拉取。 */
export const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * 缓存文件的绝对路径。
 *
 * @returns {string}
 */
export function cacheFilePath() {
  return join(resolveDshHome(), CACHE_DIR_NAME, CACHE_FILE_NAME);
}

/**
 * 读取缓存。
 *
 * 任何异常（文件缺失、JSON 损坏、版本不符）都返回 undefined —— 对调用方而言
 * 「没有缓存」和「缓存不可用」是同一种情况，都回退到实时拉取。
 *
 * @returns {Promise<object|undefined>} 缓存对象，或 undefined。
 */
export async function readCache() {
  try {
    const raw = await readFile(cacheFilePath(), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return undefined;
    if (parsed.version !== CACHE_VERSION) return undefined;
    if (!Array.isArray(parsed.servers)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/**
 * 写入缓存（原子）。
 *
 * @param {object} payload
 * @param {object[]} payload.servers 已规整的记录数组。
 * @param {object[]} [payload.categories] 分类聚合。
 * @param {number} [payload.totalCount] 广场报告的总数。
 * @param {object} [payload.lastSync] 最近一次同步的摘要（触发来源、增量计数）。
 * @returns {Promise<object>} 实际写入的缓存对象。
 */
export async function writeCache(payload) {
  const path = cacheFilePath();
  const record = {
    version: CACHE_VERSION,
    fetchedAt: Date.now(),
    totalCount: Number(payload?.totalCount) || (Array.isArray(payload?.servers) ? payload.servers.length : 0),
    categories: Array.isArray(payload?.categories) ? payload.categories : [],
    servers: Array.isArray(payload?.servers) ? payload.servers : [],
  };
  if (payload?.lastSync && typeof payload.lastSync === "object") {
    record.lastSync = payload.lastSync;
  }

  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    await writeFile(temp, JSON.stringify(record), "utf8");
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true }).catch(() => {});
  }
  return record;
}

/**
 * 缓存是否仍然新鲜。
 *
 * @param {object|undefined} cache 缓存对象。
 * @param {number} [ttlMs] 新鲜度阈值。
 * @returns {boolean}
 */
export function isFresh(cache, ttlMs = DEFAULT_TTL_MS) {
  if (!cache || typeof cache.fetchedAt !== "number") return false;
  return Date.now() - cache.fetchedAt < ttlMs;
}

/** 清空缓存（面板上的「重置缓存」用）。 */
export async function clearCache() {
  await rm(cacheFilePath(), { force: true }).catch(() => {});
}
