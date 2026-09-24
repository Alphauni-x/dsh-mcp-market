/**
 * Typert strict codec 构造器 —— 同时兼容两代 harness 契约。
 *
 * 上游把 strict codec 从「直接持有 schema」改成「持有 schema 工厂」：
 *   - 早期版本读 `codec.schema`，要求 `schema.parse` 可调用；
 *   - 较新版本读 `codec.create`，要求 `typeof create === "function"`，并在边界上执行
 *     `codec.create().parse(value)`。
 * 两代都只做 `typeof` 检查且都不拒绝多余属性，因此同一个对象同时带上 `schema` 与
 * `create` 即可在两代运行时上通过 —— 不需要任何版本探测。
 *
 * @param {string} typeSymbol 稳定的类型符号，用于跨边界诊断。
 * @param {object} schema zod schema。
 * @returns {object} strict codec。
 */
export function strictCodec(typeSymbol, schema) {
  return {
    mode: "strict",
    typeSymbol,
    schema,
    create: () => schema,
  };
}
