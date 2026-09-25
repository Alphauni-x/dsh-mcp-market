/**
 * 客户端 bundle 的「无浏览器」渲染冒烟测试。
 *
 * 目的：拦住只在运行时才炸的问题（例如 `Fragment is not defined`、
 * primitives 组件名写错、属性结构变化）。做法是完全模拟宿主加载客户端 bundle
 * 的路径：
 *
 *   1. 装出 `window.__ModuleLoader__.load`
 *   2. import lib/client.js，拿到 bundle factory
 *   3. 用假的 `require` 注入 react / jsx-runtime / primitives
 *   4. 用假的 ctx 调用 apply()，捕获它注册进来的两个插槽组件
 *   5. 用 react-dom/server 真正渲染这两个组件
 *
 * 渲染期间任何 ReferenceError / TypeError 都会让测试失败。
 * 注意：primitives 用替身（真实包是宿主注入的，离线拿不到）。
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";

const require = createRequire(import.meta.url);
const { createElement } = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const jsxRuntime = require("react/jsx-runtime");

assert.ok(createElement && renderToStaticMarkup && jsxRuntime, "react / react-dom 未就绪");

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

const thrown = [];
const consoleErrors = [];

function record(scope, err) {
  thrown.push(`${scope}：${err && err.stack ? err.stack : String(err)}`);
}

// ─────────────────── 1. 浏览器全局的最小替身 ───────────────────

const styleTags = [];

globalThis.document = {
  querySelector: () => null,
  createElement: () => {
    const node = { attributes: {}, textContent: "" };
    node.setAttribute = (key, value) => {
      node.attributes[key] = value;
    };
    return node;
  },
  head: { appendChild: (node) => styleTags.push(node) },
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

check("bundle 已注册到 __ModuleLoader__", bundle !== null);
check("bundle id 正确", Boolean(bundle) && bundle.id === "dsh-mcp-market");
check("bundle 暴露 factory", Boolean(bundle) && typeof bundle.factory === "function");

// ─────────────────── 2. 假 require ───────────────────

const primitiveCalls = [];

const primitives = {
  Button: (props) => {
    const { children, icon, ...rest } = props;
    primitiveCalls.push("Button");
    return createElement("button", rest, icon, children);
  },
  Switch: (props) => {
    const { children, ...rest } = props;
    primitiveCalls.push("Switch");
    return createElement("span", { ...rest, "data-primitive": "switch" }, children);
  },
  Tag: (props) => {
    const { children, ...rest } = props;
    primitiveCalls.push("Tag");
    return createElement("span", { ...rest, "data-primitive": "tag" }, children);
  },
  // 真 Menu 会把 anchor 渲染在原地、列表挂到 portal；这里只保留「接线」
  // 信息（开了没、选中项、可选 id），够断言工具栏两个下拉接对了就行。
  Menu: (props) => {
    const { anchor, items, selectedId, open } = props;
    primitiveCalls.push("Menu");
    return createElement(
      "span",
      {
        "data-primitive": "menu",
        "data-open": String(Boolean(open)),
        "data-selected": selectedId === undefined ? "" : String(selectedId),
        "data-items": (items || []).map((item) => item.id).join(","),
        "data-labels": (items || []).map((item) => item.label).join("|"),
      },
      anchor,
    );
  },
  IconChevronDownOutlineRegular: (props) => {
    primitiveCalls.push("IconChevronDownOutlineRegular");
    return createElement("svg", { "data-icon": "chevron-down", width: props.size, height: props.size });
  },
  IconSlidersTwoOutlineRegular: (props) => {
    primitiveCalls.push("IconSlidersTwoOutlineRegular");
    return createElement("svg", { "data-icon": "sliders", width: props.size, height: props.size });
  },
};

const fakeRequire = (id) => {
  if (id === "react") return require("react");
  if (id === "react/jsx-runtime") return jsxRuntime;
  if (id === "@deepseek-ai/dsh-client-ui-primitives") return primitives;
  throw new Error(`意外的 require：${id}`);
};

let mod = null;
try {
  mod = bundle.factory(fakeRequire);
} catch (err) {
  record("factory()", err);
}

check("factory() 未抛错", thrown.length === 0);
check("factory 返回 apply", Boolean(mod) && typeof mod.apply === "function");
check("factory 返回 inject 数组", Boolean(mod) && Array.isArray(mod.inject));
check("NS 正确", Boolean(mod) && mod.NS === "mcp-market");

// ─────────────────── 3. 假 ctx，跑真实 apply ───────────────────

const dicts = {};
const registered = [];

const stubService = () => ({
  status: async () => ({ ok: true, value: { cachedCount: 0, totalCount: 0, fresh: false, fetchedAt: 0, ttlMs: 0 } }),
  search: async () => ({ ok: true, value: { servers: [], totalCount: 0, categories: [], source: "cache", cachedAt: 0 } }),
  categories: async () => ({ ok: true, value: { categories: [] } }),
  sync: async () => ({ ok: true, value: { added: 0, updated: 0, removed: 0, scanned: 0, elapsedMs: 0 } }),
  plan: async () => ({ ok: true, value: {} }),
  detail: async () => ({ ok: true, value: {} }),
  list: async () => ({ ok: true, value: { servers: [], patch: { path: "/tmp/cordis.patch.yml" } } }),
  install: async () => ({ ok: true, value: {} }),
  remove: async () => ({ ok: true, value: {} }),
  setEnabled: async () => ({ ok: true, value: {} }),
  test: async () => ({ ok: true, value: { ok: true, tools: [] } }),
});

const services = {
  "remote.mcpMarket": stubService(),
  "remote.mcpInstaller": stubService(),
  layout: { selectPanel: () => {} },
};

// 词典按 locale 分组注册（{ zh, en }），bind 时取当前语言。
// 缺词条时回退成 key 本身 —— 与线上 makeT 行为保持一致。
const bindTo = (ns, locale = "zh") => {
  const table = (dicts[ns] && dicts[ns][locale]) || {};
  return (key, params) => {
    const raw = table[key] !== undefined ? table[key] : key;
    if (!params) return raw;
    return raw.replace(/\{(\w+)\}/g, (_, name) => (params[name] === undefined ? `{${name}}` : String(params[name])));
  };
};

const ctx = {
  effect: (fn) => {
    if (typeof fn === "function") fn();
  },
  locale: {
    register: (ns, dict) => {
      dicts[ns] = dict;
      return () => {};
    },
    bind: (ns) => bindTo(ns),
  },
  remote: { $mount: async () => ({ ok: true }) },
  get: (name) => services[name],
  slots: {
    inject: (slotName, fn) => {
      if (typeof fn === "function") fn();
    },
    register: (spec, Component) => {
      registered.push({ spec, Component });
    },
  },
};

const originalError = console.error;
console.error = (...args) => consoleErrors.push(args.map((a) => (a && a.stack) || String(a)).join(" "));

try {
  mod.apply(ctx);
} catch (err) {
  record("apply()", err);
}

check("apply() 未抛错", thrown.length === 0);
check("词典已注册", Boolean(dicts["mcp-market"]));
check("样式已注入", styleTags.length === 1);
check("共注册 2 个插槽", registered.length === 2);

const sidebar = registered.find((item) => item.spec.name === "sidebar.panellist");
const main = registered.find((item) => item.spec.name === "main");

check("侧边栏插槽已注册", Boolean(sidebar));
check("主区插槽已注册", Boolean(main));
check("两个插槽 id/key 一致", Boolean(sidebar && main) && sidebar.spec.id === main.spec.key);

let sidebarLabel = "";
try {
  sidebarLabel = sidebar.spec.label();
} catch (err) {
  record("侧边栏 label()", err);
}
check("侧边栏标签渲染为「MCP 广场」", sidebarLabel === "MCP 广场");

// ─────────────────── 4. 真实渲染 ───────────────────

const t = ctx.locale.bind("mcp-market");

let sidebarHtml = "";
try {
  sidebarHtml = renderToStaticMarkup(createElement(sidebar.Component));
} catch (err) {
  record("侧边栏图标渲染", err);
}

let mainHtml = "";
try {
  const face = typeof main.spec.inject === "function" ? main.spec.inject() : main.spec.inject || {};
  mainHtml = renderToStaticMarkup(createElement(main.Component, { ...face, t }));
} catch (err) {
  record("主区面板渲染", err);
}

check("侧边栏图标渲染成功", sidebarHtml.length > 0);
check("主区面板渲染成功", mainHtml.length > 0);
check("主区根节点使用 MM_page", mainHtml.includes("MM_page"));
check("渲染出「广场」标签", mainHtml.includes("广场"));
check("渲染出「已安装」标签", mainHtml.includes("已安装"));
check("渲染出搜索框", mainHtml.includes("搜索名称、作者或用途"));
check(
  "渲染出空态或加载态",
  mainHtml.includes("加载中") || mainHtml.includes("没有匹配的服务") || mainHtml.includes("还没有本地索引"),
);
check("primitives 组件被真实调用", primitiveCalls.length > 0);

// 工具栏的两个下拉：原来是原生 <select>，控件外壳和弹出层都由操作系统绘制，
// 和旁边那排 DSH 按钮不是一个视觉体系。现在改成原生 Menu。
check("工具栏渲染出 2 个下拉", (mainHtml.match(/data-primitive="menu"/g) || []).length === 2);
check("排序下拉可选项正确", mainHtml.includes('data-items="relevance,stars,views,updated"'));
check("范围下拉可选项正确", mainHtml.includes('data-items="all,true,false"'));
check("下拉默认收起", !mainHtml.includes('data-open="true"'));
check("排序默认「相关度」", mainHtml.includes('data-selected="relevance"'));
check("范围默认「全部」", mainHtml.includes('data-selected="all"'));
check("两个下拉都带折叠箭头", (mainHtml.match(/data-icon="chevron-down"/g) || []).length === 2);
check("排序下拉带前置图标", mainHtml.includes('data-icon="sliders"'));
check("不再渲染原生 select", !/<select/.test(mainHtml));

// ─────────────────── 4b. 分类中文名 ───────────────────

// 魔搭接口只给英文 slug；中文名来自官网 i18n 词条 + 我们的补译表。
const zhCat = (value) => mod.categoryLabel(bindTo("mcp-market", "zh"), value);
const enCat = (value) => mod.categoryLabel(bindTo("mcp-market", "en"), value);

check("官网官方译名沿用", zhCat("developer-tools") === "开发者工具" && zhCat("scientific-tool") === "科研工具");
check("官方译名（英文）不出错", enCat("developer-tools") === "Developer Tools");
check("补译分类有中文名", zhCat("databases") === "数据库" && zhCat("app-automation") === "应用自动化");
check("未收录 slug 兜底为标题形式", zhCat("brand-new-thing") === "Brand New Thing" && enCat("brand-new-thing") === "Brand New Thing");
check("全大写缩写不被改写法", zhCat("AIGC") === "AIGC");
check("分类表覆盖全部 100 个已知分类", Object.keys(mod.CATEGORY_NAMES).length >= 100);
check(
  "每个分类都有中英两名",
  Object.values(mod.CATEGORY_NAMES).every((pair) => Array.isArray(pair) && pair.length === 2 && pair[0] && pair[1]),
);

// ─────────────────── 5. 渲染期无致命报错 ───────────────────

const fatal = [...thrown, ...consoleErrors].filter((text) =>
  /ReferenceError|TypeError|is not defined|is not a function|Cannot read/.test(text),
);

check("渲染期无未定义标识符 / 类型错误", fatal.length === 0);

console.error = originalError;

if (fatal.length > 0) {
  console.log("\n  致命报错：");
  for (const text of fatal.slice(0, 6)) console.log(`    · ${String(text).split("\n")[0]}`);
}

const warnings = consoleErrors.filter((text) => !fatal.includes(text));
if (warnings.length > 0) {
  console.log(`\n  渲染期的 React 告警（${warnings.length} 条，不判失败）：`);
  for (const text of warnings.slice(0, 5)) console.log(`    · ${String(text).split("\n")[0]}`);
}

// ─────────────────── 6. 源码契约（离线守卫） ───────────────────

/**
 * 这一节拦的是「语法正确、静态检查也过，但运行时才出问题」的东西：
 *
 *   · 主题令牌拼错 —— CSS 自定义属性拼错不会报错，只会静默回退成继承色。
 *     实测：`--dsw-alias-state-warning-primary` 在光主题下未定义，正确拼法是
 *     `--dsw-alias-state-warn-primary`。这种错只能靠白名单守住。
 *   · `window.confirm` —— 原生对话框会同步阻塞渲染主线程，打断面板自己的
 *     异步刷新，外观也和主题化的面板不搭。删除改成了卡片内二次确认。
 */
const sourceText = await readFile(new URL("../lib/client.js", import.meta.url), "utf8");

// 光主题下逐个探测过、确认真实存在的令牌（见 README「主题令牌」一节）。
const VERIFIED_TOKENS = new Set([
  "--dsw-alias-bg-layer-1",
  "--dsw-alias-bg-layer-3",
  "--dsw-alias-border-l1",
  "--dsw-alias-border-l2",
  "--dsw-alias-interactive-bg-hover",
  "--dsw-alias-label-primary",
  "--dsw-alias-label-secondary",
  "--dsw-alias-label-tertiary",
  "--dsw-alias-markdown-code-block",
  "--dsw-alias-state-business-primary",
  "--dsw-alias-state-error-primary",
  "--dsw-alias-state-success-primary",
  "--dsw-alias-state-warn-primary",
  "--dsw-alias-state-warn-tertiary",
]);

// 已知别名：某些主题层只提供带 -warning- 的长拼法。
// 作为 var() 的第二参数（回退值）出现是允许的，但绝不能是唯一写法。
const TOLERATED_FALLBACK_TOKENS = new Set(["--dsw-alias-state-warning-primary"]);

const usedTokens = [...new Set(sourceText.match(/--dsw-alias-[a-z0-9-]+/g) || [])];
const unknownTokens = usedTokens.filter((token) => !VERIFIED_TOKENS.has(token) && !TOLERATED_FALLBACK_TOKENS.has(token));

check(
  `用到的主题令牌全部在已验证白名单内${unknownTokens.length ? `（可疑：${unknownTokens.join(", ")}）` : ""}`,
  unknownTokens.length === 0,
);
check("未把 state-warning-primary 当作唯一写法", !/var\(--dsw-alias-state-warning-primary\)/.test(sourceText));
check(
  "warn 色带回了回退链",
  /var\(--dsw-alias-state-warn-primary,var\(--dsw-alias-state-warning-primary/.test(sourceText),
);

check("客户端不再使用 window.confirm", !/window\.confirm\s*\(/.test(sourceText));
check("删除改成卡片内二次确认", sourceText.includes("MM_confirm") && sourceText.includes("confirmRemove"));
// 踩过的坑：把「删除」按钮直接接到真删除上，第一下就删掉了，确认态根本没机会出现。
check("首次点击只进入确认态", /onClick: \(\) => onAskRemove\(item\)/.test(sourceText));
check("只有确认条才调真删除", /onClick: \(\) => onRemove\(item\)/.test(sourceText));
check("确认态下能取消", sourceText.includes("onCancelRemove") && sourceText.includes("cancelRemove"));
check("安装/启停后做状态收敛刷新", /settleInstalled/.test(sourceText) && /aliveRef/.test(sourceText));
// 按条件收敛，不按固定次数：MCP 冷启动实测可能超过 10 秒，写死几轮会刚好错过。
check(
  "收敛是按 pending 条件而非固定次数",
  /stillPending/.test(sourceText) &&
    /fiberPhase !== "active"/.test(sourceText) &&
    /timeoutMs = 25000/.test(sourceText),
);
check("收敛在后台跑、不占着按钮", /void settleInstalled\(\)/.test(sourceText));
check(
  "收敛轮询在卸载后停止",
  /if \(!aliveRef\.current\) return;/.test(sourceText),
);

check("分类 chip 用本地化名而不是 slug", /categoryLabel\(t, item\.Value\)/.test(sourceText));
check("工具栏下拉基于原生 Menu", /h\(Menu, \{/.test(sourceText));
// 面板根节点带 overflow:hidden，下拉就地渲染会被裁掉，必须走 portal。
check("下拉列表走 portal", /portal: true/.test(sourceText));
check("星标改成图标而不是「星」字", /h\(StarIcon, \{ size: 11 \}\)/.test(sourceText));
check("星标图标是自绘 SVG", /viewBox: "0 0 16 16"/.test(sourceText) && /fill: "currentColor"/.test(sourceText));

// ─────────────────── 7. 手动添加 MCP 服务器 ───────────────────

check("端点两端接线一致", sourceText.includes('desc("mcpInstaller", "installCustom", ["payload"])'));
check("调用处走同一方法名", sourceText.includes('call("mcpInstaller", "installCustom", payload)'));
check("有独立的手动添加对话框", /const CustomDialog = \(/.test(sourceText));
check("工具栏有入口", sourceText.includes('t("addManual")'));
check("对话框同时渲染于主页面", sourceText.includes("customOpen") && /onSubmit: addCustom/.test(sourceText));
check("环境变量支持动态增删", sourceText.includes("MM_kvRow") && sourceText.includes("setEnvRows") && sourceText.includes("removeRow(index)"));
// 删到只剩一行时补回一个空行，否则表单会没有可填的输入框。
check("删空后补回一行", /next\.length > 0 \? next : \[\{ key: "", value: "" \}\]/.test(sourceText));
// 命令与地址互斥：切到远程时不该把 command 一起提交上去。
check("按传输方式切换字段", /isStdio\s*\n?\s*\? h\(/.test(sourceText) && sourceText.includes("streamable-http"));
check("参数按空白拆分", /split\(\/\\s\+\/\)/.test(sourceText));
check("添加后跳到已安装页", /setTab\("installed"\)/.test(sourceText));

// ─────────────────── 8. 命令行摘要框：不要自己的滚动条 ───────────────────

// 踩过的坑：`pre.MM_kv` 是 dialogBody（flex 列）的子项，默认 flex-shrink:1 会把它
// 压到内容高度以下，配合 overflow:auto 就画出一条滚动条；底色用的是 markdown 代码块
// 色，和旁边的输入框不是一个体系，看着像「另一个控件」。
const kvRule = (sourceText.match(/\.MM_kv\{([^}]*)\}/) || [])[1] || "";
check("命令行摘要框不再自带滚动与限高", kvRule !== "" && !/overflow/.test(kvRule) && !/max-height/.test(kvRule));
check("命令行摘要框与输入框同底色", /\.MM_kv\{[^}]*background:var\(--dsw-alias-bg-layer-1\)/.test(sourceText));
check("命令行摘要框不参与压缩", /\.MM_kv\{[^}]*flex:none/.test(sourceText));

// ─────────────────── 9. 词典完整性 ───────────────────

/**
 * 这一节拦的是词条本身的问题，语法与渲染测试都抓不到：
 *
 *   · 重复键 —— 同一对象里后者覆盖前者。加了「本地命令」这种词条，名字如果和已有的
 *     重名，运行时静默取到旧值：手动添加对话框的按钮显示成已安装卡片的 `stdio` 标签。
 *   · 打错的键 —— `t("cwd")` 找不到就原样返回 `cwd`，面板上直接出现这个英文单词。
 */
function dictKeysOf(text, marker) {
  const start = text.indexOf(marker);
  const keys = [];
  if (start < 0) return keys;
  for (const line of text.slice(start).split("\n").slice(1)) {
    if (/^    \};/.test(line)) break;
    const hit = line.match(/^      ([A-Za-z_][A-Za-z0-9_]*):/);
    if (hit) keys.push(hit[1]);
  }
  return keys;
}

const zhKeys = dictKeysOf(sourceText, "    const zh = {");
const enKeys = dictKeysOf(sourceText, "    const en = {");

for (const [name, keys] of [
  ["zh", zhKeys],
  ["en", enKeys],
]) {
  const seen = new Set();
  const dup = keys.filter((key) => (seen.has(key) ? true : (seen.add(key), false)));
  check(`${name} 词典没有重复键${dup.length ? `（重复：${dup.join(", ")}）` : ""}`, dup.length === 0);
}

const usedKeys = [...new Set([...sourceText.matchAll(/\bt\("([A-Za-z0-9_]+)"/g)].map((hit) => hit[1]))];
const missing = (set) => usedKeys.filter((key) => !set.has(key));
const missingZh = missing(new Set(zhKeys));
const missingEn = missing(new Set(enKeys));
check(`t() 用到的键都在 zh 词典里${missingZh.length ? `（缺：${missingZh.join(", ")}）` : ""}`, missingZh.length === 0);
check(`t() 用到的键都在 en 词典里${missingEn.length ? `（缺：${missingEn.join(", ")}）` : ""}`, missingEn.length === 0);
// 键名对不上时 t() 不会报错，所以这条必须覆盖到「新加的对话框字段」这类动态文本。
check("两套词典键集合一致", zhKeys.length === enKeys.length && zhKeys.every((key) => enKeys.includes(key)));

// ─────────────────── 汇总 ───────────────────

console.log(`\n结果：${pass} 通过 / ${failures.length} 失败`);
if (failures.length > 0) {
  console.log(`失败项：${failures.join("、")}`);
  process.exitCode = 1;
}
