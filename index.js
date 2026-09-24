/**
 * dsh-mcp-market —— 插件 host 入口。
 *
 * 在 DSH Web UI 里提供「MCP 广场」面板：浏览 / 搜索魔搭社区的 MCP 服务，
 * 一键安装到本机 profile，并管理已装服务的启停与删除。
 *
 * 两个服务：
 *   - mcpMarket     广场数据（搜索、同步、生成安装方案）
 *   - mcpInstaller  本地操作（安装、删除、启停、测试连接）
 *
 * 本包只消费 harness 的服务，不 import 任何 harness 包，因此不会引入第二份
 * cordis（`@deepseek-ai/cordis` 仅作为 peerDependency 存在）。
 *
 * 可配置项（写在 profile 的 cordis.patch.yml 里，按 id 覆盖本行即可热重载）：
 *
 *   - id: mcp-market
 *     name: dsh-mcp-market
 *     config:
 *       autoSync: true        # 是否开启周期性同步
 *       intervalHours: 24     # 周期长度（0.25 ~ 168）
 *       syncOnStart: true     # 启动时若缓存缺失/过期则补一次
 *       startDelayMs: 15000   # 启动补同步的延迟
 *       maxRequests: 400      # 单次同步的请求预算（关键词扇出）
 *
 * 关于同步策略：魔搭的列表接口对匿名请求有「偏移 300 硬上限」——
 * 单条查询最多只能翻到第 300 条。所以同步不是顺序翻页，而是换关键词做扇出
 * （见 lib/modelscope/client.js 的 fetchByKeywords）。代价是单次同步要发
 * 几十到几百次请求，换来的是索引覆盖率从 300/12520 提升到 ~7000/12520。
 */

import { MarketGateway } from "./lib/market/gateway.js";
import { InstallerGateway } from "./lib/mcp/gateway.js";
import { MarketScheduler, normalizeSchedule } from "./lib/market/scheduler.js";
import { MARKET_MANIFEST } from "./lib/wire.js";

export const name = "dsh-mcp-market";

/** 需要的宿主服务：注册 wire manifest、读 loader 条目、统计已注册工具。 */
export const inject = ["typert", "loader", "tools"];

/**
 * @param {object} ctx Cordis 上下文。
 * @param {object} [config] 本插件在 cordis.patch.yml 中的 config 块。
 */
export function apply(ctx, config) {
  const options = normalizeSchedule(config);
  const market = new MarketGateway(ctx);
  const installer = new InstallerGateway(ctx, market);
  const scheduler = new MarketScheduler({ ctx, market, options });

  // 面板要通过 status 看到调度状态，先把执行器挂上去再启动。
  market.scheduler = scheduler;

  ctx.effect(() => ctx.typert.register(MARKET_MANIFEST), "dsh-mcp-market: typert manifest");

  // 定时同步的定时器随 fiber 销毁（HMR 重载、插件停用都会自动清掉）。
  ctx.effect(() => {
    scheduler.start();
    return () => {
      scheduler.started = false;
    };
  }, "dsh-mcp-market: scheduler");

  // 让 installer 的引用在 fiber 生命周期内保持有效。
  ctx.effect(() => () => {
    void installer;
  }, "dsh-mcp-market: gateways");
}
