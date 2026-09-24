/**
 * profile 路径解析。
 *
 * 插件安装在 `<profile>/node_modules/<pkg>/` 下，因此包根往上两级就是 profile 目录，
 * 也就是 `cordis.patch.yml` 所在的位置。
 */

import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

/** 本包根目录。 */
const PACKAGE_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/**
 * 当前 profile 的 `cordis.patch.yml` 绝对路径。
 *
 * 优先用宿主提供的 `ctx.baseUrl`（file: 协议时即为 profile 目录）；
 * 取不到时回退到「包所在位置往上两级」的推导。
 *
 * @param {object} ctx Cordis 上下文。
 * @returns {string}
 */
export function profilePatchPath(ctx) {
  const base = ctx?.baseUrl;
  if (typeof base === "string" && base.length > 0) {
    try {
      const url = new URL(base);
      if (url.protocol === "file:") return join(fileURLToPath(url), "cordis.patch.yml");
    } catch {
      // 非 URL 形态：走回退推导。
    }
  }
  return join(resolve(PACKAGE_ROOT, "../.."), "cordis.patch.yml");
}

/** 本包根目录（供需要读包内资源的模块使用）。 */
export { PACKAGE_ROOT };
