/**
 * 关键词扇出的专项测试。
 *
 * 背景（都是实测结论，不是假设）：
 *   - 魔搭列表接口的 `Query` 是真正生效的关键词搜索；`Criterion` 完全不生效。
 *   - 匿名访问存在「偏移 300 硬上限」：`(PageNumber-1)*PageSize >= 300` 一律返回空，
 *     TotalCount 同时归零。
 * 所以「拉全量」只能靠换关键词扇出，本文件锁住这套策略的几个关键性质。
 */

import assert from "node:assert/strict";

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

const {
  ANON_OFFSET_LIMIT,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  buildKeywordSeed,
  fetchAll,
  fetchByKeywords,
  fetchPage,
} = await import("../lib/modelscope/client.js");

const online = process.env.SKIP_ONLINE !== "1";

// ─────────────────── [1] 词表构造 ───────────────────

console.log("\n[1] buildKeywordSeed");
const seed = buildKeywordSeed();

check("默认词表非空", seed.length > 0, `实际 ${seed.length}`);
check("含全部小写字母", "abcdefghijklmnopqrstuvwxyz".split("").every((c) => seed.includes(c)));
check("含全部数字", "0123456789".split("").every((c) => seed.includes(c)));
check("无重复项", new Set(seed.map((s) => s.toLowerCase())).size === seed.length);

const withCats = buildKeywordSeed([{ Value: "finance", Count: 10 }, { Value: "map", Count: 3 }]);
check("分类词被并入", withCats.includes("finance") && withCats.includes("map"));
check("分类词与种子去重", new Set(withCats.map((s) => s.toLowerCase())).size === withCats.length);

check("maxKeywords 生效", buildKeywordSeed(undefined, { maxKeywords: 5 }).length === 5);
check("非法 categories 不抛", Array.isArray(buildKeywordSeed(null)) && Array.isArray(buildKeywordSeed([{}])));
check("分类项缺 Value 时跳过", buildKeywordSeed([{ Count: 1 }]).length === buildKeywordSeed().length);

check("匿名配额常量是 300", ANON_OFFSET_LIMIT === 300, `实际 ${ANON_OFFSET_LIMIT}`);

// ─────────────────── [2] 在线：扇出确实比单查询看到更多 ───────────────────

if (online) {
  console.log("\n[2] fetchByKeywords（在线）");

  const base = await fetchPage({ pageNumber: 1, pageSize: 1 });
  const totalCount = base.totalCount;
  check("拿到广场总量", totalCount > 0, `totalCount=${totalCount}`);
  check(
    "单查询被匿名配额截断（totalCount 远大于 300）",
    totalCount > ANON_OFFSET_LIMIT,
    `totalCount=${totalCount}`,
  );

  // 只取少量词，保证测试跑得快。
  const small = await fetchByKeywords({
    keywords: ["a", "b", "c", "mcp", "search"],
    pageSize: MAX_PAGE_SIZE,
    maxPagesPerKeyword: 3,
    pageDelayMs: 60,
    maxRequests: 30,
  });

  check("扇出返回记录", small.servers.length > 0, `实际 ${small.servers.length}`);
  check(
    "每个关键词的产出都不超过匿名配额",
    small.servers.length <= small.keywords * ANON_OFFSET_LIMIT,
    `${small.servers.length} > ${small.keywords} × ${ANON_OFFSET_LIMIT}`,
  );
  check("词表首项是空关键词（用于取总量）", small.keywords === 6, `keywords=${small.keywords}`);
  check("请求数与关键词数相匹配", small.requests > 0 && small.requests <= 30, `requests=${small.requests}`);
  check("无失败关键词", small.failedKeywords.length === 0, small.failedKeywords.join(","));
  check("返回值带总量", small.totalCount > 0);

  const ids = small.servers.map((s) => s.Id ?? `${s.Publisher}/${s.Name}`);
  check("扇出结果已按 id 去重", new Set(ids).size === ids.length);

  // 回归：关键词查询返回的 FiledAgg 是该词的局部聚合（count 是个位数），
  // 曾被误当成全局聚合覆盖掉，导致面板分类计数从 3.6k 变成 12。
  const sumOf = (agg) => (agg || []).reduce((acc, item) => acc + (Number(item.Count) || 0), 0);
  check("分类聚合保持全局口径", sumOf(small.categoryAgg) === sumOf(base.categoryAgg), `${sumOf(small.categoryAgg)} vs ${sumOf(base.categoryAgg)}`);
  check("分类聚合计数远大于本次抓取量", sumOf(small.categoryAgg) > small.servers.length);

  check(
    "maxRequests 生效（不会超预算）",
    (
      await fetchByKeywords({
        keywords: ["a", "b", "c", "d", "e", "f"],
        pageSize: MAX_PAGE_SIZE,
        maxPagesPerKeyword: 3,
        pageDelayMs: 0,
        maxRequests: 2,
      })
    ).requests <= 2,
  );

  check(
    "空关键词表回落默认词表",
    (await fetchByKeywords({ keywords: [], maxRequests: 2, pageDelayMs: 0 })).keywords > 2,
  );

  console.log("\n[3] 匿名配额行为");
  const p3 = await fetchPage({ pageNumber: 3, pageSize: 100 });
  check("偏移 200 仍可读", p3.servers.length > 0, `实际 ${p3.servers.length}`);
  const p4 = await fetchPage({ pageNumber: 4, pageSize: 100 });
  check("偏移 300 起返回空", p4.servers.length === 0, `实际 ${p4.servers.length}`);
  check("越界时 TotalCount 归零", p4.totalCount === 0, `实际 ${p4.totalCount}`);

  const alt = await fetchPage({ pageNumber: 31, pageSize: 10 });
  check("换成小页宽同样卡在偏移 300", alt.servers.length === 0, `实际 ${alt.servers.length}`);

  const withinAlt = await fetchPage({ pageNumber: 30, pageSize: 10 });
  check("小页宽在配额内可读", withinAlt.servers.length > 0, `实际 ${withinAlt.servers.length}`);

  console.log("\n[4] fetchAll 的截断标记");
  const all = await fetchAll({ pageSize: MAX_PAGE_SIZE, maxPages: 50, pageDelayMs: 0 });
  check("fetchAll 在配额处停下", all.servers.length === ANON_OFFSET_LIMIT, `实际 ${all.servers.length}`);
  check("fetchAll 标记 truncated", all.truncated === true, `truncated=${all.truncated}`);
  check("fetchAll 保留真实总量", all.totalCount > ANON_OFFSET_LIMIT, `totalCount=${all.totalCount}`);
} else {
  console.log("\n[2] 在线部分已跳过（SKIP_ONLINE=1）");
}

// ─────────────────── 汇总 ───────────────────

console.log(`\n结果：${pass} 通过 / ${failures.length} 失败`);
if (failures.length > 0) {
  console.log(`失败项：${failures.join("、")}`);
  process.exitCode = 1;
}
