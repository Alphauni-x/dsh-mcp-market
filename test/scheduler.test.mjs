/**
 * 定时同步测试。
 *
 * 覆盖三块：
 *   - 配置规整（含定时器溢出这条容易踩的坑）
 *   - 调度器生命周期（启动、幂等、失败不抛、并发去重）
 *   - 启动补同步的「新鲜就跳过」判定（用临时 DSH_HOME，不动真实缓存）
 *
 * 运行：node test/scheduler.test.mjs
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 必须在调用任何缓存相关函数之前设置，测试才不会碰到 ~/.dsh。
process.env.DSH_HOME = await mkdtemp(join(tmpdir(), "dsh-mcp-market-test-"));

const { clearCache, readCache, writeCache } = await import("../lib/market/cache.js");
const {
  DEFAULT_SCHEDULE,
  MAX_INTERVAL_HOURS,
  MIN_INTERVAL_HOURS,
  MarketScheduler,
  normalizeSchedule,
} = await import("../lib/market/scheduler.js");
const { MarketGateway } = await import("../lib/market/gateway.js");

let pass = 0;
let fail = 0;

const check = (name, condition, extra) => {
  if (condition) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${extra ? `  → ${extra}` : ""}`);
  }
};

/** 假 ctx：记录 effect 的清理函数，收集日志。 */
function makeCtx() {
  const disposers = [];
  const logs = [];
  return {
    disposers,
    logs,
    effect(fn, label) {
      const dispose = fn();
      disposers.push({ label, dispose });
      return () => {
        if (typeof dispose === "function") dispose();
      };
    },
    logger: {
      info: (...args) => logs.push(["info", args.join(" ")]),
      warn: (...args) => logs.push(["warn", args.join(" ")]),
    },
  };
}

// ───────────────────────── [1] 配置规整 ─────────────────────────

console.log("\n[1] normalizeSchedule：默认值与边界");
const defaults = normalizeSchedule();
check("空配置用全部默认值", defaults.autoSync === true && defaults.intervalHours === 24 && defaults.syncOnStart === true);
check("默认 startDelayMs", defaults.startDelayMs === DEFAULT_SCHEDULE.startDelayMs);
check("默认 maxRequests", defaults.maxRequests === DEFAULT_SCHEDULE.maxRequests);
check("undefined config 不抛", normalizeSchedule(undefined).intervalHours === 24);
check("非对象 config 不抛", normalizeSchedule("nope").intervalHours === 24);
check("autoSync 显式 false", normalizeSchedule({ autoSync: false }).autoSync === false);
check("autoSync 非布尔按 false 处理", normalizeSchedule({ autoSync: "yes" }).autoSync === false);
check("syncOnStart 显式 false", normalizeSchedule({ syncOnStart: false }).syncOnStart === false);

check("intervalHours 过小收到下限", normalizeSchedule({ intervalHours: 0.001 }).intervalHours === MIN_INTERVAL_HOURS);
check("intervalHours 过大收到上限", normalizeSchedule({ intervalHours: 9999 }).intervalHours === MAX_INTERVAL_HOURS);
check("intervalHours 负数回落默认", normalizeSchedule({ intervalHours: -5 }).intervalHours === DEFAULT_SCHEDULE.intervalHours);
check("intervalHours 非数字回落默认", normalizeSchedule({ intervalHours: "abc" }).intervalHours === DEFAULT_SCHEDULE.intervalHours);
check("intervalHours 数字字符串可用", normalizeSchedule({ intervalHours: "12" }).intervalHours === 12);
check("intervalHours null 回落默认", normalizeSchedule({ intervalHours: null }).intervalHours === DEFAULT_SCHEDULE.intervalHours);

check("startDelayMs 负值回落默认", normalizeSchedule({ startDelayMs: -1 }).startDelayMs === DEFAULT_SCHEDULE.startDelayMs);
check("startDelayMs 过大收到 10 分钟", normalizeSchedule({ startDelayMs: 9e9 }).startDelayMs === 600000);
check("maxRequests 过小回落默认", normalizeSchedule({ maxRequests: 0 }).maxRequests === DEFAULT_SCHEDULE.maxRequests);
check("maxRequests 过大收到 2000", normalizeSchedule({ maxRequests: 1e9 }).maxRequests === 2000);

console.log("\n[2] 定时器溢出防护");
const maxIntervalMs = MAX_INTERVAL_HOURS * 3600 * 1000;
check("上限毫秒数在 32 位安全区内", maxIntervalMs <= 2 ** 31 - 1, `实际 ${maxIntervalMs}`);
check("下限小于默认值", MIN_INTERVAL_HOURS < DEFAULT_SCHEDULE.intervalHours);
check("上限大于默认值", MAX_INTERVAL_HOURS > DEFAULT_SCHEDULE.intervalHours);
check("7 天上限不会触发 TimeoutOverflow", maxIntervalMs === 604800000);

// ───────────────────────── [3] 调度器生命周期 ─────────────────────────

console.log("\n[3] start()：注册与幂等");

{
  const ctx = makeCtx();
  let calls = 0;
  const scheduler = new MarketScheduler({
    ctx,
    market: { sync: async () => { calls += 1; return emptyResult(); } },
    options: normalizeSchedule({ autoSync: false, syncOnStart: false }),
  });

  scheduler.start();
  check("autoSync=false 也标记为已启动", scheduler.started === true);
  check("autoSync=false 不注册定时器", ctx.disposers.length === 0);
  check("autoSync=false 的 nextRunAt 为 0", scheduler.state.nextRunAt === 0);
  check("state.autoSync 为 false", scheduler.state.autoSync === false);

  scheduler.start();
  check("重复 start 幂等", ctx.disposers.length === 0);
  check("未发生同步调用", calls === 0);
}

{
  const ctx = makeCtx();
  const scheduler = new MarketScheduler({
    ctx,
    market: { sync: async () => emptyResult() },
    options: normalizeSchedule({ autoSync: true, intervalHours: 2, syncOnStart: false }),
  });

  scheduler.start();
  check("autoSync=true 注册 1 个定时器", ctx.disposers.length === 1);
  check("effect 带有可读标签", ctx.disposers[0].label.includes("定时同步"), ctx.disposers[0].label);
  check("nextRunAt 落在未来", scheduler.state.nextRunAt > Date.now());
  check("intervalMs 为 2 小时", scheduler.state.intervalMs === 2 * 3600 * 1000);
  check("日志记下同步周期", ctx.logs.some(([level, text]) => level === "info" && text.includes("每 2 小时")));
  ctx.disposers[0].dispose();
}

{
  const ctx = makeCtx();
  const scheduler = new MarketScheduler({
    ctx,
    market: { sync: async () => emptyResult() },
    options: normalizeSchedule({ autoSync: true, syncOnStart: true }),
  });
  scheduler.start();
  check("开启启动同步时多注册 1 个定时器", ctx.disposers.length === 2);
  ctx.disposers.forEach((item) => typeof item.dispose === "function" && item.dispose());
}

// ───────────────────────── [4] run() 的成功 / 失败 / 并发 ─────────────────────────

console.log("\n[4] run()：结果记录与错误隔离");

{
  const ctx = makeCtx();
  let captured;
  const scheduler = new MarketScheduler({
    ctx,
    market: { sync: async (payload) => { captured = payload; return emptyResult(); } },
    options: normalizeSchedule({ syncOnStart: false }),
  });

  const result = await scheduler.run("auto");
  check("成功时返回结果", result !== undefined);
  check("把 maxRequests 透传给 sync", captured.maxRequests === DEFAULT_SCHEDULE.maxRequests);
  check("把 trigger 透传给 sync", captured.trigger === "auto");
  check("记录 lastRunAt", scheduler.state.lastRunAt > 0);
  check("记录 lastResult", scheduler.state.lastResult !== undefined);
  check("成功后清空 lastError", scheduler.state.lastError === "");
  check("结束后 running 复位", scheduler.state.running === false);
}

{
  const ctx = makeCtx();
  const scheduler = new MarketScheduler({
    ctx,
    market: { sync: async () => { throw new Error("广场接口返回 HTTP 503"); } },
    options: normalizeSchedule({ syncOnStart: false }),
  });

  const result = await scheduler.run("auto");
  check("失败时返回 undefined 而不抛", result === undefined);
  check("失败被记录到 lastError", scheduler.state.lastError.includes("HTTP 503"), scheduler.state.lastError);
  check("失败后 running 复位", scheduler.state.running === false);
  check("失败写 warn 日志", ctx.logs.some(([level, text]) => level === "warn" && text.includes("同步失败")));
}

{
  const ctx = makeCtx();
  let concurrent = 0;
  let peak = 0;
  const scheduler = new MarketScheduler({
    ctx,
    market: {
      sync: async () => {
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        await new Promise((resolve) => setTimeout(resolve, 25));
        concurrent -= 1;
        return emptyResult();
      },
    },
    options: normalizeSchedule({ syncOnStart: false }),
  });

  const [a, b, c] = await Promise.all([scheduler.run("auto"), scheduler.run("auto"), scheduler.run("manual")]);
  check("并发 run 只真正执行一次", peak === 1, `峰值 ${peak}`);
  check("并发时第二个调用返回 undefined", b === undefined && c === undefined);
  check("并发时第一个调用拿到结果", a !== undefined);
}

// ───────────────────────── [5] 启动补同步的新鲜度判定 ─────────────────────────

console.log("\n[5] runStartup()：新鲜就跳过");

{
  await clearCache();
  const ctx = makeCtx();
  let calls = 0;
  const scheduler = new MarketScheduler({
    ctx,
    market: { sync: async (payload) => { calls += 1; return { ...emptyResult(), trigger: payload.trigger }; } },
    options: normalizeSchedule({ syncOnStart: true }),
  });

  await scheduler.runStartup();
  check("无缓存时触发同步", calls === 1);
  check("上次运行标记为 startup", scheduler.state.lastResult?.trigger === "startup");
  check("无缓存时写 info 日志", ctx.logs.some(([level, text]) => level === "info" && text.includes("本地无缓存")));
}

{
  await writeCache({ servers: [{ publisher: "a/b", name: "b" }], totalCount: 1 });
  const ctx = makeCtx();
  let calls = 0;
  const scheduler = new MarketScheduler({
    ctx,
    market: { sync: async () => { calls += 1; return emptyResult(); } },
    options: normalizeSchedule({ syncOnStart: true }),
  });

  await scheduler.runStartup();
  check("缓存新鲜时跳过同步", calls === 0);
  check("跳过时写 info 日志", ctx.logs.some(([level, text]) => level === "info" && text.includes("跳过启动同步")));
}

{
  // 直接落盘一份过期缓存：writeCache 会把 fetchedAt 设成当下，所以这里手写文件。
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  const { cacheFilePath } = await import("../lib/market/cache.js");
  const path = cacheFilePath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      fetchedAt: Date.now() - 7 * 24 * 3600 * 1000,
      totalCount: 1,
      categories: [],
      servers: [{ publisher: "a/b", name: "b" }],
    }),
    "utf8",
  );
  const stale = await readCache();
  check("手写的过期缓存可被读取", stale !== undefined);
  check("过期缓存的 fetchedAt 确实是 7 天前", Date.now() - stale.fetchedAt > 6 * 3600 * 1000);

  const ctx = makeCtx();
  let calls = 0;
  const scheduler = new MarketScheduler({
    ctx,
    market: { sync: async () => { calls += 1; return emptyResult(); } },
    options: normalizeSchedule({ syncOnStart: true }),
  });

  await scheduler.runStartup();
  check("缓存过期时补同步", calls === 1);
  check("过期时写 info 日志", ctx.logs.some(([level, text]) => level === "info" && text.includes("缓存已过期")));
}

{
  const ctx = makeCtx();
  const scheduler = new MarketScheduler({
    ctx,
    market: { sync: async () => { throw new Error("网络不可达"); } },
    options: normalizeSchedule({ syncOnStart: true }),
  });
  await scheduler.runStartup();
  check("启动同步失败不上抛", scheduler.state.lastError.includes("网络不可达"));
}

console.log("\n[6] 缓存 lastSync 与并发去重（gateway 层）");

{
  await writeCache({
    servers: [{ publisher: "a/b", name: "b" }],
    totalCount: 1,
    lastSync: { at: 1700000000000, trigger: "auto", added: 3, updated: 2, removed: 1 },
  });
  const cache = await readCache();
  check("lastSync 被写入缓存", cache?.lastSync?.at === 1700000000000);
  check("lastSync 保留触发来源", cache?.lastSync?.trigger === "auto");
  check("缓存版本未变（向后兼容）", cache?.version === 1);

  await writeCache({ servers: [] });
  const cleared = await readCache();
  check("不传 lastSync 时不残留旧值", cleared?.lastSync === undefined);
}

{
  // 只借原型上的 sync 方法，绕开需要真实 ctx 的构造函数。
  const gateway = Object.create(MarketGateway.prototype);
  gateway.pendingSync = undefined;
  let runs = 0;
  gateway.runSync = async () => {
    runs += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { added: 0, updated: 0, removed: 0 };
  };

  const [first, second] = await Promise.all([gateway.sync({}), gateway.sync({})]);
  check("gateway.sync 并发只跑一次", runs === 1, `实际 ${runs}`);
  check("gateway.sync 共享同一结果", first === second);
  check("结束后释放 pendingSync", gateway.pendingSync === undefined);
}

await rm(process.env.DSH_HOME, { recursive: true, force: true });

console.log(`\n${fail === 0 ? "全部通过" : "存在失败"}：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);

/** 空的同步结果，字段与真实返回保持一致。 */
function emptyResult() {
  return {
    added: 0,
    updated: 0,
    removed: 0,
    unchanged: 0,
    addedList: [],
    updatedList: [],
    totalCount: 0,
    scanned: 0,
    truncated: false,
    elapsedMs: 1,
    fetchedAt: Date.now(),
    trigger: "auto",
  };
}
