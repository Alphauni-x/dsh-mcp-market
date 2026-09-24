/**
 * wire 契约测试：host manifest 与 client CONTRIBUTION 必须一一对应，
 * 且方法名不能落在客户端命名空间服务的保留字里。
 *
 * 为什么要有这个测试：
 * 1. 两边的 descriptor 是手写的两份，容易改一边漏一边；
 * 2. `install` / `remove` 这种名字单独看毫无问题，但会让客户端挂载直接抛
 *    `client api: method "..." conflicts with its namespace service`，
 *    表现是整个主面板白屏 —— 线上只有真跑起来才看得到。
 *    这里用静态断言把它挡在提交前。
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

let pass = 0;
const failures = [];

function check(name, condition) {
  if (condition) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(name);
    console.log(`  ✗ ${name}`);
  }
}

// ─────────────────── 1. host manifest 侧的静态检查 ───────────────────

const { MARKET_MANIFEST, RESERVED_REMOTE_METHODS } = await import("../lib/wire.js");

check("manifest 存在 invocations", Array.isArray(MARKET_MANIFEST.invocations));
assert.ok(RESERVED_REMOTE_METHODS instanceof Set, "RESERVED_REMOTE_METHODS 必须是 Set");
check("保留字集合非空", RESERVED_REMOTE_METHODS.size > 0);

const manifestMethods = MARKET_MANIFEST.invocations.map((item) => item.method);

check(
  "manifest 方法名未使用保留字",
  manifestMethods.every((method) => !RESERVED_REMOTE_METHODS.has(method)),
);

const offenders = manifestMethods.filter((method) => RESERVED_REMOTE_METHODS.has(method));
if (offenders.length > 0) console.log(`    冲突：${offenders.join("、")}`);

check("manifest 方法名无重复", new Set(manifestMethods).size === manifestMethods.length);
check(
  "每个 invocation 的 id 与 service/method 自洽",
  MARKET_MANIFEST.invocations.every((item) => item.id === `dsh-mcp-market#${item.service}/${item.method}`),
);
check(
  "每个 invocation 的 namespace 等于 service",
  MARKET_MANIFEST.invocations.every((item) => item.namespace === item.service),
);

// ─────────────────── 2. 载入 client bundle，取出 CONTRIBUTION ───────────────────

globalThis.document = {
  querySelector: () => null,
  createElement: () => ({ setAttribute() {}, textContent: "" }),
  head: { appendChild() {} },
};

let bundle = null;
globalThis.window = {
  __ModuleLoader__: {
    load(spec) {
      bundle = spec;
    },
  },
};

await import("../lib/client.js");
assert.ok(bundle, "客户端 bundle 未注册");

const primitives = {
  Button: (props) => props.children,
  Switch: (props) => props.children,
  Tag: (props) => props.children,
};

const fakeRequire = (id) => {
  if (id === "react") return require("react");
  if (id === "react/jsx-runtime") return require("react/jsx-runtime");
  if (id === "@deepseek-ai/dsh-client-ui-primitives") return primitives;
  throw new Error(`意外的 require：${id}`);
};

const mod = bundle.factory(fakeRequire);

let contribution = null;
const registered = [];

const ctx = {
  effect: (fn) => {
    if (typeof fn === "function") fn();
  },
  locale: { register: () => () => {}, bind: () => (key) => key },
  remote: {
    $mount: async (input) => {
      contribution = input;
      return { ok: true };
    },
  },
  get: () => undefined,
  slots: {
    inject: (slotName, fn) => {
      if (typeof fn === "function") fn();
    },
    register: (spec, Component) => registered.push({ spec, Component }),
  },
};

mod.apply(ctx);

check("apply 期间调用了 $mount", contribution !== null);

// ─────────────────── 3. host 与 client 逐条比对 ───────────────────

const clientDescriptors = (contribution && contribution.descriptors) || [];

check("CONTRIBUTION 声明了 descriptors", clientDescriptors.length > 0);
check(
  "两侧端点数量一致",
  clientDescriptors.length === MARKET_MANIFEST.invocations.length,
);

check(
  "client 方法名未使用保留字",
  clientDescriptors.every((item) => !RESERVED_REMOTE_METHODS.has(item.method)),
);

const clientKeys = clientDescriptors.map((item) => `${item.service}/${item.method}`).sort();
const manifestKeys = MARKET_MANIFEST.invocations.map((item) => `${item.service}/${item.method}`).sort();

check(
  "两侧 service/method 完全一致",
  clientKeys.length === manifestKeys.length && clientKeys.every((key, index) => key === manifestKeys[index]),
);

if (clientKeys.join(",") !== manifestKeys.join(",")) {
  const onlyClient = clientKeys.filter((key) => !manifestKeys.includes(key));
  const onlyHost = manifestKeys.filter((key) => !clientKeys.includes(key));
  if (onlyClient.length > 0) console.log(`    仅客户端声明：${onlyClient.join("、")}`);
  if (onlyHost.length > 0) console.log(`    仅 host 声明：${onlyHost.join("、")}`);
}

const clientIds = clientDescriptors.map((item) => item.id).sort();
const manifestIds = MARKET_MANIFEST.invocations.map((item) => item.id).sort();
check("两侧 id 完全一致", clientIds.join(",") === manifestIds.join(","));

check(
  "两端数量与插槽注册自洽",
  registered.length === 2 && bundle.id === "dsh-mcp-market",
);

// ─────────────────── 汇总 ───────────────────

console.log(`\n结果：${pass} 通过 / ${failures.length} 失败`);
if (failures.length > 0) {
  console.log(`失败项：${failures.join("、")}`);
  process.exitCode = 1;
}
