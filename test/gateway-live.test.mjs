/**
 * 「已装载的服务直接读宿主状态」的测试（gateway.liveToolNames）。
 *
 * 背景：测试连接过去一律真起一个进程。实测 stdio 型热启动 545ms，其中 450ms 花在
 * 重建运行环境上 —— 而那部分成本，宿主里那份活着的连接早就付过了。所以对「确实
 * 跑起来了」的服务改为直接读宿主已注册的工具；其余的（没装、停用、或装了但一个
 * 工具都没注册）仍然真连，因为失败原因只有真连说得出来。
 *
 * 这里重点守住第二条：**绿点会撒谎**。stdio 服务起不来时插件 fiber 照样 active
 * （failOnStartupError 默认为 false），只有工具数会诚实地停在 0。若把 active 当成
 * 「能用」，用户就会看到一个绿色的「成功，0 个工具」，比报错还糟。
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { InstallerGateway } from "../lib/mcp/gateway.js";

let pass = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(name);
    console.log(`  ✗ ${name}${detail === undefined ? "" : `　（${detail}）`}`);
  }
}

/** 只借用原型上的方法，不跑真正构造（构造要一个完整的 cordis ctx）。 */
const gatewayWith = (ctx) => {
  const gateway = Object.create(InstallerGateway.prototype);
  gateway.ctx = ctx;
  return gateway;
};

const ctxOf = (entries, schemas) => ({
  loader: { entries: () => entries[Symbol.iterator]() },
  tools: { schemas: () => schemas },
});

const entryOf = (id, state) => ({ id, fiber: { state } });

// ─────────────────── [1] 命中：真跑起来了 ───────────────────

console.log("\n[1] 命中");
const live = gatewayWith(
  ctxOf([entryOf("spine:include:mcp-fetch", 2)], [{ name: "mcp__fetch__fetch" }, { name: "mcp__fetch__fetch_many" }]),
);
const names = live.liveToolNames({ id: "mcp-fetch" }, "fetch");
check("fiber active 且注册了工具 → 命中", Array.isArray(names));
check("返回的是剥掉前缀的工具名", names?.join(",") === "fetch,fetch_many");
// loader 会给 insert 行加命名空间前缀，字面 id 查不到 —— 这条覆盖 getLoaderEntry 的后缀兜底。
check("带 include: 前缀的 id 仍能命中", names !== undefined);

// ─────────────────── [2] 不命中：宁可慢，也不能给出假的绿 ───────────────────

console.log("\n[2] 不命中");
const withTools = [{ name: "mcp__fetch__fetch" }];
const cases = [
  ["fiber 还是 pending(1)", ctxOf([entryOf("mcp-fetch", 1)], withTools)],
  ["fiber 是 loading(0)", ctxOf([entryOf("mcp-fetch", 0)], withTools)],
  ["fiber 已 failed(3)", ctxOf([entryOf("mcp-fetch", 3)], withTools)],
  ["fiber 正在卸载(5)", ctxOf([entryOf("mcp-fetch", 5)], withTools)],
  ["loader 里没有这一条", ctxOf([entryOf("mcp-other", 2)], withTools)],
  ["没有 loader 服务", { tools: { schemas: () => withTools } }],
];
for (const [label, ctx] of cases) {
  check(`${label} → 退回真连`, gatewayWith(ctx).liveToolNames({ id: "mcp-fetch" }, "fetch") === undefined);
}

// 最关键的一条：active 但没有工具 = 服务其实没起来。
// 这条要是放过去，用户会看到「连接成功，服务返回 0 个工具」，比报错更难排查。
check(
  "active 但 0 个工具 → 退回真连（绿点在撒谎）",
  gatewayWith(ctxOf([entryOf("mcp-fetch", 2)], [])).liveToolNames({ id: "mcp-fetch" }, "fetch") === undefined,
);
check(
  "只有别的服务的工具 → 退回真连",
  gatewayWith(ctxOf([entryOf("mcp-fetch", 2)], [{ name: "mcp__other__x" }])).liveToolNames({ id: "mcp-fetch" }, "fetch") ===
    undefined,
);

const throwing = {
  loader: { entries: () => [entryOf("mcp-fetch", 2)][Symbol.iterator]() },
  tools: {
    schemas: () => {
      throw new Error("boom");
    },
  },
};
check(
  "tools.schemas 抛错 → 退回真连，不炸",
  gatewayWith(throwing).liveToolNames({ id: "mcp-fetch" }, "fetch") === undefined,
);

// ─────────────────── [3] 入参边界 ───────────────────

console.log("\n[3] 入参边界");
const healthy = gatewayWith(ctxOf([entryOf("mcp-fetch", 2)], withTools));
check("row 没有 id → 不命中", healthy.liveToolNames({}, "fetch") === undefined);
check("row 为 undefined → 不命中", healthy.liveToolNames(undefined, "fetch") === undefined);
check("id 非字符串 → 不命中", healthy.liveToolNames({ id: 42 }, "fetch") === undefined);
check("serverName 为空 → 不命中", healthy.liveToolNames({ id: "mcp-fetch" }, "") === undefined);

// 前缀必须带末尾的 __：否则 serverName 取 memo 时会把 memory 的工具算进来，
// 于是 memo 这个「没跑起来」的服务被误判成健康。
const overlapping = gatewayWith(
  ctxOf([entryOf("mcp-memo", 2)], [{ name: "mcp__memory__create_entities" }]),
);
check("memo 不吞 memory 的工具（短前缀不误判）", overlapping.liveToolNames({ id: "mcp-memo" }, "memo") === undefined);

// ─────────────────── [4] 与 test() 的接线是契约 ───────────────────

console.log("\n[4] test() 接线");
const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "..", "lib", "mcp", "gateway.js"), "utf8");
check("命中时标注来源为宿主", /source: "host"/.test(source));
check("未命中才落到 probe", /const live = this\.liveToolNames\(row, config\.serverName\);\s*\n\s*if \(live !== undefined\)/.test(source));
check("宿主分支排在 probe 之前", source.indexOf("liveToolNames(row, config.serverName)") < source.indexOf("return probeMcpServer(config)"));
check("预检分支不受影响", /typeof payload\.publisher === "string"/.test(source));

// ─────────────────── 汇总 ───────────────────

console.log(`\n结果：${pass} 通过 / ${failures.length} 失败`);
if (failures.length > 0) {
  console.log(`失败项：${failures.join("、")}`);
  process.exitCode = 1;
}
