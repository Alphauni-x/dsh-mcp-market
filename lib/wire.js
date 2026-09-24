/**
 * dsh-mcp-market —— Typert wire manifest。
 *
 * 声明 host 侧对前端暴露的全部端点。前端 `lib/client.js` 里的 CONTRIBUTION
 * 必须与本文件的 invocation 列表一一对应（id / service / method 都要一致）。
 *
 * ⚠️ 方法名禁区：宿主用 `RemoteNamespaceService` 投影命名空间，该类的原型上
 * 已有 `install / installDirect / installScoped / remove / has / empty /
 * assertMethodAvailable`，另有保留字段 `ctx / name / namespace / methods /
 * invokeRemote`。以上任一名字一旦用作 method，客户端挂载时会直接抛
 * `client api: method "..." conflicts with its namespace service`，
 * 整个插件的主面板都渲染不出来。所以这里用 `installServer` / `removeServer`
 * 这类带后缀的名字。新增端点前请先核对 `RESERVED_REMOTE_METHODS`。
 */

import { z } from "zod";
import { strictCodec } from "./codec.js";

/**
 * 客户端命名空间服务不可用的方法名。
 * 来源：dsh-api-gateway/lib/client.js 的 `RemoteNamespaceService`（原型方法 +
 * `REMOTE_NAMESPACE_FIELDS`）。test/wire.test.mjs 会逐条断言没有踩雷。
 */
export const RESERVED_REMOTE_METHODS = new Set([
  // REMOTE_NAMESPACE_FIELDS
  "ctx",
  "empty",
  "invokeRemote",
  "methods",
  "name",
  "namespace",
  // RemoteNamespaceService 自己的原型方法
  "assertMethodAvailable",
  "has",
  "install",
  "installDirect",
  "installScoped",
  "remove",
]);

/** 结果结构复杂且会随广场字段演进，边界不做深度校验，由前端自行防御。 */
const loose = z.unknown();

const envMap = z.record(z.string(), z.string());

/** 构造一个参数 codec（统一走 payload 位置传参）。 */
const param = (typeName, schema) => ({
  name: "payload",
  wire: "payload",
  source: "json",
  codec: strictCodec(`dsh-mcp-market#${typeName}`, schema),
});

/** 构造结果 codec。 */
const result = (typeName, schema = loose) => strictCodec(`dsh-mcp-market#${typeName}`, schema);

/** 无参端点。 */
const noArgs = (service, method, resultName) => ({
  id: `dsh-mcp-market#${service}/${method}`,
  service,
  namespace: service,
  method,
  invocation: { kind: "direct" },
  parameters: [],
  result: result(resultName),
});

/** 带一个 payload 的端点。 */
const withPayload = (service, method, typeName, resultName, schema) => ({
  id: `dsh-mcp-market#${service}/${method}`,
  service,
  namespace: service,
  method,
  invocation: { kind: "direct" },
  parameters: [param(typeName, schema)],
  result: result(resultName),
});

export const MARKET_MANIFEST = {
  package: "dsh-mcp-market",
  face: "host",
  schemas: [],
  invocations: [
    noArgs("mcpMarket", "status", "MarketStatus"),
    withPayload(
      "mcpMarket",
      "search",
      "SearchPayload",
      "SearchResult",
      z.object({
        query: z.string().optional(),
        category: z.string().optional(),
        hosted: z.boolean().optional(),
        sort: z.enum(["relevance", "stars", "views", "updated", "name"]).optional(),
        source: z.enum(["cache", "live"]).optional(),
        pageNumber: z.number().int().min(1).optional(),
        pageSize: z.number().int().min(1).max(100).optional(),
      }),
    ),
    noArgs("mcpMarket", "categories", "CategoriesResult"),
    withPayload(
      "mcpMarket",
      "sync",
      "SyncPayload",
      "SyncResult",
      z.object({
        // 匿名配额把单条查询锁在 300 条，同步靠关键词扇出，预算按「请求数」而不是「页数」算。
        maxRequests: z.number().int().min(1).max(2000).optional(),
        maxKeywords: z.number().int().min(1).max(400).optional(),
        pagesPerKeyword: z.number().int().min(1).max(10).optional(),
        allowEmpty: z.boolean().optional(),
        trigger: z.enum(["manual", "auto", "startup"]).optional(),
      }),
    ),
    withPayload(
      "mcpMarket",
      "plan",
      "PlanPayload",
      "PlanResult",
      z.object({
        publisher: z.string().min(1),
        serverName: z.string().optional(),
        env: envMap.optional(),
        preferLocal: z.boolean().optional(),
      }),
    ),
    withPayload(
      "mcpMarket",
      "detail",
      "DetailPayload",
      "DetailResult",
      z.object({ publisher: z.string().min(1) }),
    ),

    noArgs("mcpInstaller", "list", "InstallerListResult"),
    withPayload(
      "mcpInstaller",
      "installServer",
      "InstallPayload",
      "InstallResult",
      z.object({
        publisher: z.string().min(1),
        serverName: z.string().optional(),
        env: envMap.optional(),
        preferLocal: z.boolean().optional(),
        enabled: z.boolean().optional(),
      }),
    ),
    withPayload(
      "mcpInstaller",
      "removeServer",
      "RemovePayload",
      "RemoveResult",
      z.object({ serverName: z.string().min(1) }),
    ),
    withPayload(
      "mcpInstaller",
      "setEnabled",
      "SetEnabledPayload",
      "SetEnabledResult",
      z.object({ serverName: z.string().min(1), enabled: z.boolean() }),
    ),
    withPayload(
      "mcpInstaller",
      "test",
      "TestPayload",
      "TestResult",
      z.object({
        serverName: z.string().optional(),
        publisher: z.string().optional(),
        env: envMap.optional(),
        preferLocal: z.boolean().optional(),
      }),
    ),
  ],
  model: { services: [], events: [], objects: [] },
};
