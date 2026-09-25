/**
 * mcpInstaller —— 本地 MCP 服务器管理服务（host 侧）。
 *
 * 一个 MCP 服务器就是 profile `cordis.patch.yml` 里的一行：
 *   安装 = 追加行 · 删除 = 移除行 · 停用 = 置 `disabled: true`
 * 写完后由 DSH 的 HMR 热加载，无需重启。
 *
 * 本服务只动自己受管块里的行；文件里其它 MCP 行（来自别的插件或手写）只读不写，
 * 并且在冲突时明确报错，而不是静默覆盖。
 */

import { TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import {
  MANAGED_ROW_ID_PREFIX,
  MCP_PLUGIN_NAME,
  extractManagedRows,
  listMcpPatchRows,
  readPatchFile,
  serverNameFromRowId,
  writeManagedRows,
} from "./patch-editor.js";
import { profilePatchPath } from "./paths.js";
import {
  configFromCustomInput,
  configFromPatchRow,
  isManagedRow,
  patchRowToView,
  toPatchRow,
  validateServerInput,
} from "./model.js";
import { fiberPhaseOf, getLoaderEntry, mcpToolCount, waitForLoaderState } from "./status.js";
import { probeMcpServer } from "./probe.js";

/** 写 patch 后等待 HMR 生效的时间上限。 */
const RECONCILE_TIMEOUT_MS = 5000;

export class InstallerGateway extends TypertRemoteService {
  /**
   * @param {object} ctx Cordis 上下文。
   * @param {object} market mcpMarket 服务实例（用于查广场记录）。
   */
  constructor(ctx, market) {
    super(ctx, "mcpInstaller");
    this.market = market;
  }

  get C() {
    return this.ctx;
  }

  patchPath() {
    return profilePatchPath(this.C);
  }

  /** 读取受管行与外部行。 */
  async readRows() {
    const path = this.patchPath();
    const raw = await readPatchFile(path);
    const managed = extractManagedRows(raw);
    const managedIds = new Set(managed.map((row) => row.id).filter((id) => typeof id === "string"));
    const external = listMcpPatchRows(raw).filter(
      (row) => typeof row.id !== "string" || !managedIds.has(row.id),
    );
    return { path, raw, managed, external };
  }

  /** 把一个 patch 行渲染成前端视图（含运行态）。 */
  decorate(row, managed) {
    const entry = typeof row.id === "string" ? getLoaderEntry(this.C, row.id) : undefined;
    const enabled = row.disabled !== true;
    const view = patchRowToView(row, {
      managed,
      fiberPhase: fiberPhaseOf(entry?.fiber?.state),
      toolCount: enabled ? mcpToolCount(this.C, resolveName(row)) : 0,
    });
    return view;
  }

  /**
   * 列出全部 MCP 服务器：本插件受管 + 外部（只读）。
   */
  async list() {
    const patch = { path: this.patchPath(), ok: false, error: null };
    try {
      const { path, managed, external } = await this.readRows();
      patch.path = path;
      patch.ok = true;

      return {
        servers: managed.map((row) => this.decorate(row, true)).filter(Boolean),
        externalServers: external.map((row) => this.decorate(row, false)).filter(Boolean),
        patch,
      };
    } catch (error) {
      return {
        servers: [],
        externalServers: [],
        patch: { ...patch, error: error instanceof Error ? error.message : String(error) },
      };
    }
  }

  /**
   * 从广场安装一个服务。
   *
   * @param {object} payload
   * @param {string} payload.publisher 广场记录标识。
   * @param {string} [payload.serverName]
   * @param {Record<string,string>} [payload.env]
   * @param {boolean} [payload.preferLocal]
   * @param {boolean} [payload.enabled] 默认 true。
   *
   * 注意：方法名叫 `installServer` 而不是 `install` —— `install` 是客户端
   * 命名空间服务 `RemoteNamespaceService` 的保留方法名，同名会让客户端
   * 挂载直接失败（详见 lib/wire.js 顶部的说明）。
   */
  async installServer(payload = {}) {
    const plan = await this.market.plan({
      publisher: payload.publisher,
      serverName: payload.serverName,
      env: payload.env,
      preferLocal: payload.preferLocal,
    });

    if (plan.ok !== true) {
      throw new Error(plan.reason ?? "无法生成安装配置");
    }

    const { row, reconciled } = await this.persistConfig(plan.config, { enabled: payload.enabled });

    return {
      server: this.decorate(row, true),
      reconciled,
      kind: plan.kind,
      displayName: plan.displayName,
    };
  }

  /**
   * 手动添加：配置完全由用户给出，不经过广场。
   *
   * 与 `installServer` 的区别只在配置来源；查重、落盘、收敛全部复用
   * `persistConfig`，所以「外部行占用」「重名」这些约束两处一致。
   *
   * @param {object} payload 见 lib/wire.js 的 `InstallCustomPayload`。
   */
  async installCustom(payload = {}) {
    const config = configFromCustomInput(payload);
    const { row, reconciled } = await this.persistConfig(config, { enabled: payload.enabled });

    return {
      server: this.decorate(row, true),
      reconciled,
      kind: payload.transport,
      displayName: config.serverName,
    };
  }

  /**
   * 写入一条新的受管行：校验 → 查重 → 落盘 → 等 HMR 收敛。
   *
   * @param {object} config 官方形态的配置（须含 serverName 与 transport）。
   * @param {object} [options]
   * @param {boolean} [options.enabled] 默认 true。
   */
  async persistConfig(config, options = {}) {
    const check = validateServerInput(config);
    if (check.ok !== true) throw new Error(check.error);

    const { managed, external } = await this.readRows();

    for (const row of external) {
      if (configFromPatchRow(row)?.serverName === config.serverName) {
        throw new Error(
          `serverName "${config.serverName}" 已被 cordis.patch.yml 中的外部 MCP 行占用，请先在文件中处理`,
        );
      }
    }
    if (managed.some((row) => configFromPatchRow(row)?.serverName === config.serverName)) {
      throw new Error(`"${config.serverName}" 已安装过了`);
    }

    const enabled = options.enabled !== false;
    const row = toPatchRow(config, enabled);
    const nextRows = [...managed, row].sort(byServerName);

    await writeManagedRows(this.patchPath(), nextRows);
    const reconciled = await this.reconcile(row.id, enabled);

    return { row, reconciled, enabled };
  }

  /**
   * 删除一个受管服务器。
   *
   * @param {object} payload
   * @param {string} payload.serverName
   *
   * 方法名同样避开保留字 `remove`（见 lib/wire.js 顶部说明）。
   */
  async removeServer(payload = {}) {
    const { managed } = await this.readRows();
    const target = managed.find((row) => rowMatches(row, payload.serverName));
    if (target === undefined) {
      throw new Error(`"${payload.serverName}" 不存在，或不属于本插件管理（外部行请在配置文件中删除）`);
    }

    const nextRows = managed.filter((row) => row !== target);
    await writeManagedRows(this.patchPath(), nextRows);

    const rowId = String(target.id);
    const expected = `disabled: true`;
    const reconciled = await waitForLoaderState(
      this.C,
      rowId,
      (entry) => entry === undefined || entry.disabled === true,
      RECONCILE_TIMEOUT_MS,
    );
    void expected;

    return { ok: true, reconciled };
  }

  /**
   * 启用 / 停用一个受管服务器。
   *
   * @param {object} payload
   * @param {string} payload.serverName
   * @param {boolean} payload.enabled
   */
  async setEnabled(payload = {}) {
    const { managed } = await this.readRows();
    const target = managed.find((row) => rowMatches(row, payload.serverName));
    if (target === undefined) {
      throw new Error(`"${payload.serverName}" 不存在，或不属于本插件管理`);
    }

    const enabled = payload.enabled === true;
    if (enabled) delete target.disabled;
    else target.disabled = true;

    await writeManagedRows(this.patchPath(), managed);
    const reconciled = await this.reconcile(String(target.id), enabled);

    return { server: this.decorate(target, true), reconciled };
  }

  /**
   * 测试连接。可传已安装的 serverName，也可传一份临时配置。
   *
   * @param {object} payload
   */
  async test(payload = {}) {
    if (typeof payload.serverName === "string" && payload.transport === undefined) {
      const { managed, external } = await this.readRows();
      const row = [...managed, ...external].find((candidate) => rowMatches(candidate, payload.serverName));
      const config = configFromPatchRow(row);
      if (config === undefined) throw new Error(`"${payload.serverName}" 不存在`);
      return probeMcpServer(config);
    }

    // 未安装时的预检：由广场记录临时生成配置，只在内存里探测。
    if (typeof payload.publisher === "string") {
      const plan = await this.market.plan({
        publisher: payload.publisher,
        env: payload.env,
        preferLocal: payload.preferLocal,
      });
      if (plan.ok !== true) return { ok: false, tools: [], error: plan.reason };
      return probeMcpServer(plan.config);
    }

    return probeMcpServer(payload);
  }

  /** 等 HMR 把目标行带到期望的启停状态。 */
  async reconcile(rowId, enabled) {
    return waitForLoaderState(
      this.C,
      rowId,
      (entry) =>
        entry !== undefined && (enabled ? entry.disabled !== true : entry.disabled === true),
      RECONCILE_TIMEOUT_MS,
    );
  }
}

/** 行是否对应给定的 serverName（优先用 config.serverName，其次从受管 id 反解）。 */
function rowMatches(row, serverName) {
  if (typeof serverName !== "string" || serverName === "") return false;
  if (configFromPatchRow(row)?.serverName === serverName) return true;
  return serverNameFromRowId(row?.id) === serverName;
}

/** 供 decorate 使用：取行的 serverName。 */
function resolveName(row) {
  const fromConfig = configFromPatchRow(row)?.serverName;
  if (typeof fromConfig === "string" && fromConfig !== "") return fromConfig;
  return serverNameFromRowId(row?.id) ?? "";
}

function byServerName(a, b) {
  const left = String(configFromPatchRow(a)?.serverName ?? "");
  const right = String(configFromPatchRow(b)?.serverName ?? "");
  return left.localeCompare(right);
}

export { MANAGED_ROW_ID_PREFIX, MCP_PLUGIN_NAME, isManagedRow };
