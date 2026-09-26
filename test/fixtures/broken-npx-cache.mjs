/**
 * 假 stdio 服务：复刻「npx 缓存被装坏」的失败输出。
 *
 * 真实形态（实测自 `npx -y 12306-mcp`）：npm 先把 `.包名-随机串` 暂存目录和
 * `node_modules/<包名>` 建出来，**最后**才往里填文件。在「目录已建、内容空」
 * 那一刻被打断，就留下一个看起来完整、实际上是空壳的目录 —— 而 npx 只看目录
 * 在不在，于是每次都从空壳里加载，每次崩在同一处，永不自愈。
 *
 * 这段输出里带上了真实的缓存路径，用来验证报错能把恢复命令拼出来。
 */

const text = [
  "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/Users/tester/.npm/_npx/a1b2c3d4e5f60718/node_modules/mcp-http-server/node_modules/@modelcontextprotocol/sdk/types.js' imported from /Users/tester/.npm/_npx/a1b2c3d4e5f60718/node_modules/mcp-http-server/dist/index.js",
  "    at finalizeResolution (node:internal/modules/esm/resolve:274:11)",
  "    at moduleResolve (node:internal/modules/esm/resolve:864:10)",
  "    at defaultResolve (node:internal/modules/esm/resolve:990:11)",
  "    at ModuleJob._link (node:internal/modules/esm/module_job:182:49) {",
  "  code: 'ERR_MODULE_NOT_FOUND',",
  "  url: 'file:///Users/tester/.npm/_npx/a1b2c3d4e5f60718/node_modules/mcp-http-server/node_modules/@modelcontextprotocol/sdk/types.js'",
  "}",
  "",
].join("\n");

await new Promise((resolve) => process.stderr.write(text, resolve));
process.exit(1);
