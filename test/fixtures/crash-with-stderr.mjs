/**
 * 假 stdio 服务：往 stderr 写两行然后立刻退出。
 *
 * 复刻的是「进程起来了又马上崩」那一类失败 —— 界面只会显示
 * `MCP error -32000: Connection closed`，真因全在 stderr 上。
 *
 * 两点细节：
 *   · 第二行故意带 ANSI 颜色码，验证渲染前会被剥掉；
 *   · 写完要等回调再退出。对管道写是异步的，直接 `process.exit()` 有可能
 *     把输出丢掉 —— 那这个夹具就白写了。
 */

const text =
  "boom: cannot find module '@modelcontextprotocol/sdk/types.js'\n" +
  "\u001B[31m详情：模块解析失败，请检查依赖是否装全\u001B[0m\n";

await new Promise((resolve) => process.stderr.write(text, resolve));
process.exit(1);
