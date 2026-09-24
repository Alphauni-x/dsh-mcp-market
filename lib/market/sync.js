/**
 * 广场数据的增量同步。
 *
 * 以广场的 `Id` 为唯一键、`updatedAt`（GmtUpdated）为版本号，比对「上次缓存」与
 * 「本次拉取」，得出新增 / 更新 / 下架三类变化。避免整表重拉后无法说明「变了什么」。
 */

/**
 * 比对两份记录集合。
 *
 * @param {object[]} previous 上次的已规整记录。
 * @param {object[]} next 本次的已规整记录。
 * @returns {{ added: object[], updated: object[], removed: object[], unchanged: number }}
 */
export function diffServers(previous, next) {
  const before = indexById(previous);
  const after = indexById(next);

  const added = [];
  const updated = [];
  const removed = [];
  let unchanged = 0;

  for (const [id, server] of after) {
    const old = before.get(id);
    if (old === undefined) {
      added.push(server);
      continue;
    }
    if (isNewer(server, old)) {
      updated.push({ ...server, previous: { updatedAt: old.updatedAt, config: configSignatureOf(old) } });
      continue;
    }
    unchanged += 1;
  }

  for (const [id, server] of before) {
    if (!after.has(id)) removed.push(server);
  }

  return { added, updated, removed, unchanged };
}

/**
 * 「记录是否比旧的更新」。
 *
 * 广场的 GmtUpdated 是秒级时间戳，服务方维护不勤时可能不变，因此除了时间戳，
 * 也把连接配置的指纹纳入比较 —— 否则「改了启动参数但没改时间戳」会被漏掉。
 *
 * @param {object} current
 * @param {object} previous
 * @returns {boolean}
 */
export function isNewer(current, previous) {
  if (!previous) return true;
  const currentAt = Number(current?.updatedAt) || 0;
  const previousAt = Number(previous?.updatedAt) || 0;
  if (currentAt !== previousAt) return currentAt > previousAt;
  return configSignatureOf(current) !== configSignatureOf(previous);
}

/**
 * 连接配置的稳定指纹，用于判断「配置是否变化」（即使时间戳没变）。
 *
 * @param {object} server
 * @returns {string}
 */
export function configSignatureOf(server) {
  // 缓存里存的是精简条目，指纹已在入库时算好，直接复用。
  if (typeof server?.configFingerprint === "string") return server.configFingerprint;

  const local = (server?.serverConfig ?? []).map((entry) => ({
    command: entry?.command ?? "",
    args: Array.isArray(entry?.args) ? entry.args.map(String) : [],
  }));
  const remote = (server?.streamableHttpConfig ?? []).map((entry) => entry?.url ?? "");
  return JSON.stringify({ local, remote });
}

/**
 * 同步摘要，供面板提示用。
 *
 * @param {{ added: object[], updated: object[], removed: object[], unchanged: number }} diff
 * @param {Set<string>} installedNames 当前已安装的 serverName 集合。
 * @param {(server: object) => string} nameOf 由记录推导 serverName。
 * @returns {{ added: number, updated: number, removed: number, unchanged: number, upgradable: object[] }}
 */
export function summarize(diff, installedNames, nameOf) {
  const installed = installedNames instanceof Set ? installedNames : new Set(installedNames ?? []);
  const upgradable =
    nameOf === undefined ? [] : diff.updated.filter((server) => installed.has(nameOf(server)));

  return {
    added: diff.added.length,
    updated: diff.updated.length,
    removed: diff.removed.length,
    unchanged: diff.unchanged,
    upgradable,
  };
}

function indexById(list) {
  const map = new Map();
  for (const server of Array.isArray(list) ? list : []) {
    const id = server?.id;
    if (typeof id === "number" && id > 0) map.set(id, server);
  }
  return map;
}
