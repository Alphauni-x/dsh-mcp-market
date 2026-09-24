/**
 * 缓存条目的本地过滤与排序。
 *
 * 广场列表接口的 Criterion 参数格式未公开 —— 实测 Field/Filed/Name/Key/Category 等
 * 各种形态都会被忽略、返回全量，因此分类筛选只能在本地做。这也顺带让翻页不再打网络。
 *
 * 独立成模块（不依赖宿主包），便于单测。
 */

import { displayNameOf } from "./convert.js";

/**
 * 按关键词 / 分类 / 托管类型过滤。
 *
 * @param {object[]} entries 缓存条目。
 * @param {object} criteria
 * @param {string} [criteria.query] 关键词，匹配 publisher / 名称 / 中文名 / 简介 / 标签。
 * @param {string} [criteria.category] 分类值（广场的 kebab-case 值）。
 * @param {boolean} [criteria.hosted] 是否只看魔搭托管。
 * @returns {object[]}
 */
export function filterEntries(entries, criteria = {}) {
  const { query = "", category = "", hosted } = criteria;
  const needle = String(query).trim().toLowerCase();

  return (Array.isArray(entries) ? entries : []).filter((entry) => {
    if (hosted !== undefined && entry.hosted !== hosted) return false;
    if (category !== "" && !(entry.categories ?? []).includes(category)) return false;
    if (needle === "") return true;

    const haystack = [entry.publisher, entry.name, entry.chineseName, entry.abstract]
      .filter((value) => typeof value === "string")
      .join("\n")
      .toLowerCase();
    if (haystack.includes(needle)) return true;

    return (entry.tags ?? []).some((tag) => String(tag).toLowerCase().includes(needle));
  });
}

/**
 * 排序；返回新数组，不改动入参。
 *
 * @param {object[]} entries
 * @param {string} [sort] `relevance`（保持原序）/ `stars` / `views` / `updated` / `name`。
 * @returns {object[]}
 */
export function sortEntries(entries, sort = "relevance") {
  const list = Array.isArray(entries) ? entries : [];
  switch (sort) {
    case "stars":
      return [...list].sort((a, b) => (b.stars ?? 0) - (a.stars ?? 0));
    case "views":
      return [...list].sort((a, b) => (b.views ?? 0) - (a.views ?? 0));
    case "updated":
      return [...list].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    case "name":
      return [...list].sort((a, b) => displayNameOf(a).localeCompare(displayNameOf(b), "zh"));
    default:
      return list;
  }
}
