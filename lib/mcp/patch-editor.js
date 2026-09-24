/**
 * profile `cordis.patch.yml` 的受管块编辑器。
 *
 * 本插件只读写自己 begin/end 标记之间的 MCP 行，标记之外的字节原样保留 ——
 * 这是与其它同样管理 MCP 的插件（如 dsh-skill-mcp-panel）共存的前提：
 * 各自的标记、行 id 前缀、锁文件名都不同，因此互不覆盖。
 *
 * 写入使用同目录临时文件 + rename，并加锁以避免宿主与 CLI 并发写。
 */

import { open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseDocument, stringify } from "yaml";

/** 受管块边界标记。改动这些常量会使既有受管行「失联」，务必谨慎。 */
export const MARKET_BLOCK_BEGIN = "# >>> dsh-mcp-market:mcp:begin";
export const MARKET_BLOCK_END = "# <<< dsh-mcp-market:mcp:end";

/** DSH 官方 MCP 客户端插件名。 */
export const MCP_PLUGIN_NAME = "@deepseek-ai/dsh-mcp-client";

/** 受管行的 id 前缀；与其它插件的面板行区分。 */
export const MANAGED_ROW_ID_PREFIX = "mcp-market-";

/** 陈旧锁的判定阈值与获取超时。 */
const LOCK_STALE_MS = 30000;
const LOCK_TIMEOUT_MS = 5000;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 面板行 id ↔ serverName。 */
export function rowIdForServerName(serverName) {
  return MANAGED_ROW_ID_PREFIX + serverName;
}

/**
 * 从行 id 反解 serverName；非本插件受管行返回 undefined。
 *
 * @param {unknown} id
 * @returns {string|undefined}
 */
export function serverNameFromRowId(id) {
  if (typeof id !== "string" || !id.startsWith(MANAGED_ROW_ID_PREFIX)) return undefined;
  return id.slice(MANAGED_ROW_ID_PREFIX.length) || undefined;
}

/**
 * 读取 patch 文件；失败时带路径报错，便于用户定位。
 *
 * @param {string} path
 * @returns {Promise<string>}
 */
export async function readPatchFile(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`无法读取 cordis.patch.yml（${path}）：${detail}`);
  }
}

/**
 * 校验整份 patch 文本：可解析且顶层是数组。不解析出值、不写回。
 *
 * @param {string} raw
 */
export function validatePatchText(raw) {
  const doc = parseDocument(raw, { logLevel: "silent" });
  if (doc.errors.length > 0) {
    throw new Error(`cordis.patch.yml 解析失败：${String(doc.errors[0]?.message ?? doc.errors[0])}`);
  }
  if (!Array.isArray(doc.toJS())) {
    throw new Error("cordis.patch.yml 顶层必须是 YAML 数组");
  }
}

/** 把 YAML 顶层条目（含 insert 包裹）拍平成 patch 行。 */
function flattenPatchRows(entries) {
  const rows = [];
  if (!Array.isArray(entries)) return rows;

  const pushRow = (value) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return;
    const row = value;
    if (typeof row.id !== "string" && typeof row.name !== "string") return;

    const normalized = { ...row };
    if (typeof row.id !== "string") delete normalized.id;
    if (typeof row.name !== "string") delete normalized.name;
    if (typeof row.disabled !== "boolean") delete normalized.disabled;
    if (row.config === null || typeof row.config !== "object" || Array.isArray(row.config)) {
      delete normalized.config;
    }
    rows.push(normalized);
  };

  for (const entry of entries) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    if (Array.isArray(entry.insert)) {
      for (const row of entry.insert) pushRow(row);
    } else {
      pushRow(entry);
    }
  }
  return rows;
}

/**
 * 提取本插件受管块中的行；无标记时返回空数组。
 *
 * @param {string} raw
 * @returns {object[]}
 */
export function extractManagedRows(raw) {
  const begin = raw.indexOf(MARKET_BLOCK_BEGIN);
  const end = raw.indexOf(MARKET_BLOCK_END);
  if (begin < 0 && end < 0) return [];
  if (begin < 0 || end < 0 || end < begin) {
    throw new Error("cordis.patch.yml 中 dsh-mcp-market 受管块标记不完整（begin/end 必须成对）");
  }

  const blockStart = raw.indexOf("\n", begin);
  if (blockStart < 0) throw new Error("cordis.patch.yml 受管块格式损坏");

  const blockText = raw.slice(blockStart + 1, end);
  const doc = parseDocument(blockText, { logLevel: "silent" });
  if (doc.errors.length > 0) {
    throw new Error(`受管块解析失败：${String(doc.errors[0]?.message ?? doc.errors[0])}`);
  }
  const parsed = doc.toJS();
  if (!Array.isArray(parsed)) throw new Error("受管块内容必须是 YAML 数组");
  return flattenPatchRows(parsed);
}

/**
 * 列出整份 patch 中所有 MCP 客户端行（含非本插件受管的），用于冲突检测与展示。
 *
 * @param {string} raw
 * @returns {object[]}
 */
export function listMcpPatchRows(raw) {
  const doc = parseDocument(raw, { logLevel: "silent" });
  if (doc.errors.length > 0) return [];
  const parsed = doc.toJS();
  if (!Array.isArray(parsed)) return [];
  return flattenPatchRows(parsed).filter((row) => row.name === MCP_PLUGIN_NAME);
}

/** 生成受管块文本；无行时返回空串。 */
export function generateManagedBlock(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return "";
  const body = stringify([{ insert: rows }], { indent: 2, lineWidth: 0 });
  return `${MARKET_BLOCK_BEGIN}\n${body}${MARKET_BLOCK_END}\n`;
}

/**
 * 替换受管块；无标记且需要写入时追加到文件末尾。标记之外逐字节保留。
 *
 * @param {string} raw
 * @param {object[]} rows
 * @returns {string}
 */
export function replaceManagedBlock(raw, rows) {
  const begin = raw.indexOf(MARKET_BLOCK_BEGIN);
  const end = raw.indexOf(MARKET_BLOCK_END);
  const block = generateManagedBlock(rows);

  if (begin >= 0 || end >= 0) {
    if (begin < 0 || end < 0 || end < begin) {
      throw new Error("cordis.patch.yml 中 dsh-mcp-market 受管块标记不完整（begin/end 必须成对）");
    }
    const lineStart = raw.lastIndexOf("\n", begin - 1) + 1;
    const afterEnd = raw.indexOf("\n", end);
    const lineEnd = afterEnd < 0 ? raw.length : afterEnd + 1;
    const next = raw.slice(0, lineStart) + block + raw.slice(lineEnd);

    if (block !== "") return next;
    // 删掉最后一批受管行后文件可能只剩注释（或原本就是 `[]` 模板），
    // 必须补回流式空数组，否则不再构成合法的顶层数组。
    const meaningful = next
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"));
    if (meaningful.length === 0) return next.replace(/\s*$/, "") + "\n[]\n";
    return next;
  }

  if (block === "") return raw;

  // 空 profile 模板是流式空数组 `[]`：直接追加会变成 `[] - insert`，须先替换。
  const lines = raw.split(/\r?\n/);
  const meaningful = lines
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  if (meaningful.length === 1 && meaningful[0] === "[]") {
    const index = raw.lastIndexOf("[]");
    return raw.slice(0, index) + block + raw.slice(index + 2);
  }

  const prefix = raw.length === 0 ? "" : raw.endsWith("\n") ? "\n" : "\n\n";
  return raw + prefix + block;
}

/** 同目录临时文件 + rename 原子写。 */
export async function writeFileAtomic(path, content) {
  const temp = join(
    dirname(path),
    `.mcp-market-tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
  );
  try {
    await writeFile(temp, content, "utf8");
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true }).catch(() => {});
  }
}

/**
 * 以 `<path>.mcp-market.lock` 为锁执行 fn。
 *
 * 锁文件记录 pid 与时间；超过 30 秒视为陈旧锁自动清理，获取超时 5 秒。
 * 锁名与其它插件不同，因此各自的写入不会互相阻塞。
 *
 * @template T
 * @param {string} path
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withPatchLock(path, fn) {
  const lockPath = `${path}.mcp-market.lock`;
  const started = Date.now();
  let handle;

  while (handle === undefined) {
    try {
      handle = await open(lockPath, "wx");
    } catch (error) {
      if (!(error && typeof error === "object" && error.code === "EEXIST")) throw error;
      try {
        const info = await stat(lockPath);
        if (Date.now() - info.mtimeMs > LOCK_STALE_MS) await rm(lockPath, { force: true }).catch(() => {});
      } catch {
        // 锁在检查间隙被释放：继续重试。
      }
      if (Date.now() - started > LOCK_TIMEOUT_MS) {
        throw new Error("等待 cordis.patch.yml 写锁超时（可能有其它进程正在写入）");
      }
      await delay(50);
    }
  }

  try {
    await handle.writeFile(`${process.pid}\n${Date.now()}\n`, "utf8");
    return await fn();
  } finally {
    await handle.close().catch(() => {});
    await rm(lockPath, { force: true }).catch(() => {});
  }
}

/**
 * 读 patch → 替换受管块 → 校验 → 加锁原子写回。
 *
 * @param {string} path
 * @param {object[]} rows
 * @returns {Promise<string>} 写回后的完整文本。
 */
export async function writeManagedRows(path, rows) {
  return withPatchLock(path, async () => {
    const raw = await readPatchFile(path);
    const next = replaceManagedBlock(raw, rows);
    validatePatchText(next);
    await writeFileAtomic(path, next);
    return next;
  });
}
