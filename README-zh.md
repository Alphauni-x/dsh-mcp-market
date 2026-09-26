<div align="center">

# dsh-mcp-market

**在 DeepSeek Harness 里浏览、扫描并同步魔搭社区的 MCP 广场 —— 一键安装、启停、删除 MCP 服务器。**

</div>

---

`dsh-mcp-market` 在 DSH Web 侧边栏加一个「MCP 广场」面板。它从
[modelscope.cn/mcp](https://modelscope.cn/mcp)（1.2 万+ 服务）拉取目录，把每条记录翻译成
DSH 能用的 MCP 配置，写入 profile 的 `cordis.patch.yml` —— DSH 通过 HMR 热加载，无需重启。

[English](README.md) · [简体中文](README-zh.md)

## Features

- 🛒 **广场页** —— 搜索、排序（相关度 / 星标 / 热度 / 最近更新）、按分类与托管类型筛选，一键安装。
  分类名按魔搭官网的中文译名显示（接口只给英文 slug，中文来自官网 i18n 词条，插件内置了全部 100 个分类的对照），
  悬停可看到原始 slug。排序与筛选用的是 DSH 原生下拉，与旁边按钮同一套视觉。
- 📦 **已安装页** —— 列出 profile 中所有 MCP 服务器及其**实时状态**
  （运行中 / 启动失败 / 加载中 / 已停用）、已注册工具数，以及逐个操作：启用、停用、测试连接、删除。
  删除走卡片内二次确认（不用原生 `window.confirm`——它会同步阻塞渲染线程，外观也和面板不搭）；
  启停与安装后卡片会**自己收敛到终态**，不必手点刷新。
- 🔄 **目录同步** —— 建立本地索引，让搜索、排序与分类筛选不必每敲一个字就打网络。
  魔搭对匿名请求限制单次查询最多 300 条，所以同步改走关键词扇出（约 160 次请求），
  可覆盖 1.25 万条目录中的约 67%；面板会如实显示覆盖率，而不是假装索引是全的。
  增量比对会报告自上次同步以来**新增 / 更新 / 下架**了哪些服务。
  剩下的缺口靠搜索补齐：输入关键词时会同时向广场发起实时查询并合并结果。
- ⏱ **定时同步** —— 除了手动的「同步广场」按钮，还会**自动刷新**：按周期重新拉取索引，
  启动时若缓存缺失或已过期则补一次。两者都可配置，面板会显示上次与下次同步时间。
- 🔐 **不需要魔搭账号** —— 公开目录接口无需登录，且索引中约 **76%** 的服务自带 DSH
  可直接使用的配置（基于 8377 条实测，见下文）。
- 🩺 **安装前预检** —— 在写入配置文件之前，先真实连一次并列出该服务的工具。
- ✍️ **手动添加** —— 广场里没有、或字段对不上的服务，可以直接在面板里填：服务标识、
  调用方式（本地命令 / 远程地址）、启动命令与参数（或服务地址）。本地命令配环境变量，
  远程地址配请求头（如 `Authorization: Bearer <token>`），都是可随时增删的键值对行。
  它和广场安装走**同一条写入路径**——同样的重名与占用校验、同一个受管块、同样由 DSH 热加载，无需重启。
- 🤝 **与其它插件共存** —— 本插件只改写 `cordis.patch.yml` 中属于自己标记的块，
  其它插件的行（包括 `dsh-skill-mcp-panel`）逐字节保留。

## Install

```bash
dsh plugin --profile <profile> add dsh-mcp-market
```

或从 tarball 安装：

```bash
dsh plugin --profile <profile> add ./dsh-mcp-market-0.1.0.tgz
```

bundle patch 会自动挂载，无需手工编辑 `cordis.patch.yml`。重启一次该 profile，
然后点左侧栏的「MCP 广场」。

> **pnpm 9 用户注意**：如果安装时报
> `ERR_PNPM_ADDING_TO_ROOT — Running this command will add the dependency to the workspace root`，
> 这是因为 profile 目录里有 DSH 自己生成的 `pnpm-workspace.yaml`（`packages: [.]`），
> 被 pnpm 当成了 workspace 根。按它自己的提示补一个 `-w` 即可：
>
> ```bash
> dsh plugin --profile <profile> add -w dsh-mcp-market
> ```
>
> pnpm 10 及以后取消了这项检查，不会遇到。这是 pnpm 与 DSH 的交互问题，与本插件无关。

## How it works

```
广场面板（浏览器）
   │  Typert Remote
   ▼
Cordis host 插件
   ├─ mcpMarket     ── 魔搭接口 ──▶ 本地索引缓存
   └─ mcpInstaller  ──▶ cordis.patch.yml 受管块 ──▶ @deepseek-ai/dsh-mcp-client（HMR）
```

**一个 MCP 服务器就是 `~/.dsh/profiles/<profile>/cordis.patch.yml` 里的一行**：

```yaml
- id: mcp-market-<serverName>
  name: "@deepseek-ai/dsh-mcp-client"
  # disabled: true          # ← 「停用」就是这一个字段
  config:
    serverName: <serverName>
    transport: stdio | streamable-http
```

于是：安装 = 追加一行，删除 = 移除一行，停用 = 置 `disabled: true`。改动由 HMR 生效。

### 配置映射

| 魔搭字段 | 对应的 DSH 配置 |
|---|---|
| `StreamableHTTPServerConfig` | `transport: streamable-http` + `url`（+ `headers`） |
| `ServerConfig` | `transport: stdio` + `command` / `args` / `env` |
| `SSEServerConfig` | **不支持** —— DSH 没有 SSE transport，面板会标为「暂不支持」 |
| `EnvSchema` | 生成安装表单；`<必填>` 这类占位值绝不会被写进配置 |

优先级为「远程直连 → 本地命令」。对整份 8377 条索引的实测：

| 可用的配置 | 占比 |
|---|---|
| `ServerConfig`（本地，stdio） | 67.5% |
| `StreamableHTTPServerConfig`（直连地址） | 8.4% |
| 仅 `SSEServerConfig` → **不可安装** | 24.1% |

**索引中 75.9% 的服务可直接安装**；其中 23.4% 需要至少填一个环境变量。

> 魔搭的**托管部署**（`DeployedUrl`）需要登录账号，且返回的是 SSE 地址，DSH 用不了。
> 本插件有意不支持它 —— 不加任何凭证的本地与直连方式已覆盖大部分服务。

### 为什么索引停在 ~67%，以及同步到底做了什么

公开目录接口对匿名请求有**偏移 300 的硬上限**：一旦 `(PageNumber − 1) × PageSize` 达到 300，
后续每一页都返回空，**并且** `TotalCount` 一起归零。用 11 组「页宽 × 页码」组合实测，
截断点每次都精确落在 300 —— 这是服务端配额，不是分页写错了。所以「一路翻到没有为止」的
同步策略只能拿到 12,520 条中的 300 条（2.4%）。

真正有效的是 `Query` —— 它是货真价实的关键词搜索（`finance` → 20 条，`搜索` → 222 条，
`map` → 44 条）。于是同步改为在关键词表上扇出（26 个字母、10 个数字、约 50 个常用词，
外加目录自带的分类名），按记录 id 去重合并：

| 关键词数 | 索引条数 | 覆盖率 | 请求数 |
|---|---|---|---|
| 36（字母 + 数字） | 7,132 | 57.0% | 100 |
| 80 | 8,331 | 66.6% | 约 155 |
| 160 | 8,403 | 67.1% | 236 |

收益很快就见顶 —— 最后 80 个词只多带来 72 条 —— 所以默认词表收在 96。一次同步约 4 分钟、
160 次请求，这也是它放在后台跑、并与手动按钮共用同一把互斥锁的原因。

剩余缺口在搜索时补齐：输入关键词时，面板会同时向广场发起实时查询并合并两边结果。

### 桌面版从 Dock 启动时，stdio 型 MCP 为什么起不来

桌面版（`DeepSeek Harness.app`）从 Dock / Finder 启动时，宿主进程只继承 launchd 的
默认 `PATH`（`/usr/bin:/bin:/usr/sbin:/sbin`），里面**没有用户自己装的
`npx` / `uvx` / `pnpm`** —— 而广场里绝大多数 stdio 型 MCP 的启动命令正好是它们。
症状就是 `连接失败：spawn uvx ENOENT`：**HTTP 型的服务照常可用，本地命令型的一律失败**，
看起来像「有的服务坏了」，其实是启动方式导致宿主少了几个目录。

从终端直接跑同一个 app 不会有这个问题（`zsh` 已经把 `.zprofile` / `.zshrc` 里的
`PATH` 都 export 好了），所以这是**启动方式**的问题，不是配置写错了。

插件默认自己修：启动时若发现候选目录（`~/.local/bin`、`/opt/homebrew/bin`、
`/usr/local/bin`、`/opt/local/bin` …）不在宿主 `PATH` 上，就把它们补进
`process.env.PATH`。补这一处就够 —— 官方 `@deepseek-ai/dsh-mcp-client` 拼子进程环境时
读的正是同一份 `process.env`，所以**「测试连接」与官方真实启动会同时修好**，
而且不需要改写任何配置文件。

| 配置项 | 默认 | 说明 |
|---|---|---|
| `fixHostPath` | `true` | 关掉则完全不碰宿主 `PATH` |
| `probeLoginShell` | `true` | 补 `PATH` 时额外用 `$SHELL -lc` 取登录 shell 的完整 `PATH`（`$SHELL` 缺失时回落到 `/bin/zsh` → `/bin/bash` → `/bin/sh`）；关掉则只用内置候选目录 |

几条边界：

- 只 **prepend**，原有条目一个不丢；只补**实际存在**且原本不在 `PATH` 上的目录；
- 宿主 `PATH` 本来就没问题（例如从终端启动）时**一个字节都不改**；
- 目录都已在 `PATH` 上时待补集合为空，所以重复加载是幂等的；
- Windows 上不启用（分隔符与 `PATHEXT` 语义不同）；
- 这是**运行期**修正，不写任何配置文件，重启 app 即回到系统原状。

想自己掌控的话，把 `fixHostPath` 设为 `false`，再在对应 MCP 行的 `env` 里补一条 `PATH`
（`config.env` 的合并优先级高于父进程，官方客户端与插件的探测行为一致）：

```yaml
- id: mcp-market-fetch
  name: "@deepseek-ai/dsh-mcp-client"
  config:
    transport: stdio
    command: uvx
    args: [mcp-server-fetch]
    env:
      PATH: /Users/you/.local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin
```

### 「测试连接」为什么能秒回

一次 stdio 连接的耗时几乎全在**启动**上，跟协议本身没关系。用真实 SDK 分段实测：

| 场景 | connect | listTools | close | 总计 |
|---|---|---|---|---|
| `uvx` stdio **首次** | 5023ms | 4ms | 74ms | 5.1s |
| 同一条**第二次起** | ~475ms | 2ms | 71ms | 545ms |
| HTTP 型 | 128ms | 69ms | 1ms | 197ms |

`uvx --help` 只要 14ms —— 慢的不是 uv 这个二进制，而是它每次都要**重建一遍包的运行环境**；
`listTools` 本身只有 2ms。所以优化都冲着「别重复付启动成本」去：

1. **已装载的服务直接读宿主状态**：宿主里那份连接本来就是活的，直接问它要已注册的工具，
   不再另起一个进程（实测 545ms → 毫秒级）。
2. **关闭动作移出返回路径**：结果一出来就返回，回收子进程放后台（省约 70ms）。
3. **按钮显示已耗时秒数**：首次连接要重建环境、可能好几秒，静止的「测试中…」最难熬。

第 1 条有个必须守住的**边界**：只有「fiber 处于 `active` **且确实注册了工具**」才算命中。
stdio 服务起不来时插件 fiber 照样是 `active`（官方默认 `failOnStartupError: false`），
只有工具数会诚实地停在 0 —— 这种会照常走真连。否则你会看到「连接成功，0 个工具」，
比直接报错更难排查。

排查时记住这条签名：**绿点 + `stdio` + 0 个工具 = 必然起不来**，别只看那个点。

### 「Connection closed」：失败原因去哪了，以及为什么有的服务「永远装不上」

`PATH` 修好之后，报错会从 `spawn npx ENOENT` 变成 `MCP error -32000: Connection closed`。
这是**进步**而不是新故障：进程起来了，才轮到它自己崩。但界面上依然什么都看不出来 ——
因为原因只打在子进程的 stderr 上，而传输层默认 `stderr: "inherit"`，那些字直接写进了
宿主的 stderr，面板一个字节都收不到。

现在改成 `stderr: "pipe"`，把尾部几行（最多 6 行 / 2KB，ANSI 颜色码剥掉）拼进报错里：

```
连接失败：MCP error -32000: Connection closed
子进程输出：
boom: cannot find module '@modelcontextprotocol/sdk/types.js'
详情：模块解析失败，请检查依赖是否装全
```

同时还有个更容易踩的坑：**点「测试连接」会在超时后杀掉正在安装的进程**。

`npx -y <pkg>` 第一次运行要先把包下到 `~/.npm/_npx/<hash>/`。实测 `12306-mcp`
要装 200+ 个依赖，跑了 **8 分 44 秒**还没建完 `node_modules`，而 15 秒的探测超时
早就把它掐了。麻烦的是 npm 被中途杀死留下的是**半成品**：

- 嵌套的 `node_modules` 是空目录；
- `.package-lock.json` 里把依赖记成 `{}`；
- 旁边留着一堆 `.pkg-随机串` 暂存目录。

npx 不会自愈这种状态 —— 于是「点一次测试连接 = 掐断一次安装」，永远装不上。

现在的处理是：

| 环节 | 行为 |
|---|---|
| 冷启动判定 | 命令是 `npx` 且 `~/.npm/_npx` 里没有这个包 → 判定为冷启动 |
| 预算 | 冷启动给 60 秒（热启动仍是 15 秒） |
| **超时后** | **不杀进程**，放它继续跑 3 分钟把包装完 |
| 面板 | 超过 5 秒显示「首次运行需要下载依赖…」，并按秒计已耗时 |
| 按钮 | 测试期间禁用 —— 连点会让两个包运行器同时往同一份缓存里写 |

于是「点一次 → 等一分钟 → 再点一次」就能成功，中途的等待是有进展的。

判定刻意保守：只有 `npx` 能精确查缓存，`uvx` / `pnpx` / `bunx` 一律返回「不知道」
（按热启动处理）—— 宁可少给一次长预算，也不要让每个服务都干等一分钟。

如果已经卡在坏掉的缓存上，插件会自己认出来，并把路径直接写进报错：

```
连接失败：MCP error -32000: Connection closed
子进程输出：
  code: 'ERR_MODULE_NOT_FOUND',
  url: 'file:///Users/you/.npm/_npx/a1b2c3d4e5f60718/node_modules/mcp-http-server/node_modules/@modelcontextprotocol/sdk/types.js'
这个包的缓存不完整（上次安装被中断，留下一个空壳目录），npx 不会自动修复。清掉后重装即可：rm -rf "/Users/you/.npm/_npx/a1b2c3d4e5f60718"，再在终端里跑一次 npx -y <包名> 等它装完。
```

修起来有两种：**只补缺的部分**（快，推荐）或**整目录重来**（慢，但一定干净）。

npm 把下好的包放在内容寻址缓存 `~/.npm/_cacache` 里，所以补解包不用重新下载：

```bash
D=~/.npm/_npx/<hash>          # 报错里给的路径

# 半成品垃圾：npm 解包到一半留下的 `.包名-随机串` 暂存目录
find "$D/node_modules" -maxdepth 1 -type d -name '.*-*' -delete
# 空壳目录：壳建好了、文件还没填 —— 正是它让 npx 每次从空处加载
find "$D/node_modules" -type d -empty -delete

cd "$D" && npm install        # 按 package-lock.json 把缺的解回来
```

删掉的只有「目录存在但内容为空」和 npm 自己的中间产物，都不含有效数据；真正下好的包原样保留。

不想深究就整目录删掉重来 —— 注意**必须用配置里那条一模一样的命令**，因为 npx 的
缓存目录名是由命令算出来的，换一条命令会装到另一个目录里去：

```bash
rm -rf ~/.npm/_npx/<hash>
npx -y <pkg>     # 就是 MCP 配置里的命令；装完它会启动并停在那里，稍等一会儿按 Ctrl+C 退出
```

## 定时同步

两个触发点共用同一把锁 —— 手动同步与定时同步绝不会同时跑：

| 触发方式 | 时机 | 默认 |
|---|---|---|
| **手动** | 点面板上的「同步广场」 | 始终可用 |
| **启动** | 每次启动一次，且仅在本地缓存缺失或超过 6 小时时 | 开启，启动后 15 秒 |
| **周期** | DSH 运行期间每 `intervalHours` 一次 | 每 24 小时 |

在 profile 的 `cordis.patch.yml` 里加一行**相同 `id`** 即可覆盖 —— profile 层优先，
且 patch 是整块替换 `config`，所以要保留的键都得重写一遍：

```yaml
- id: mcp-market
  name: dsh-mcp-market
  config:
    autoSync: false        # 完全关掉周期同步
    intervalHours: 12      # 0.25 ~ 168
    syncOnStart: true
    startDelayMs: 30000
    maxRequests: 400       # 关键词扇出的请求预算
```

配置改动经 HMR 热加载。面板的状态行会一直显示当前调度与上次同步时间。
定时器绑定在插件生命周期上，停用或重载时会一并清除，不会留下野生的后台轮询。

## Compatibility

| 项目 | 状态 |
|---|---|
| DeepSeek Harness | `0.1.7-rc.1`（已验证） |
| Node | `^22.19.0 \|\| >=24.0.0` |
| 平台 | 全平台（纯 ESM，无原生代码） |
| 模型 | 任意（不涉及模型交互） |

## Development

```bash
node test/patch.test.mjs         # 配置文件安全性（改写、共存、校验）
node test/market.test.mjs        # 过滤、转换、增量比对 + 在线目录检查
node test/scheduler.test.mjs     # 同步调度：配置收敛、生命周期、并发去重
node test/keywords.test.mjs      # 关键词扇出 + 300 条匿名配额
node test/status.test.mjs        # loader 条目查找、fiber 阶段、已注册工具数与工具名
node test/host-path.test.mjs     # 宿主 PATH 补齐：幂等、只 prepend、失败降级、开关
node test/package-runner.test.mjs # 包运行器识别 + 冷启动判定（拿不准时不下结论）
node test/gateway-live.test.mjs  # 已装载服务的宿主直读（含「绿点撒谎」时退回真连）
node test/probe-close.test.mjs   # 探测的关闭不阻塞返回 + 失败要毫秒级返回
node test/probe-recovery.test.mjs # stderr 透传 + 冷启动超时不掐断安装 + 坏缓存诊断
node test/client-render.test.mjs # 不开浏览器渲染客户端 bundle + 源码契约守卫
node test/wire-contract.test.mjs # host manifest ↔ 客户端 CONTRIBUTION 一致性 + 保留字
```

`market.test.mjs` 与 `keywords.test.mjs` 需要联网；设 `SKIP_ONLINE=1`（或断网）可只跑离线部分。

`client-render.test.mjs` 用替身模块加载器装载客户端 bundle，再用 `react-dom/server` 真正渲染 ——
它能拦住「只会在运行时炸」的问题，例如某个未定义标识符会把整个面板打成白屏。它还带一节
**源码契约守卫**，拦语法检查抓不到的东西：主题令牌拼写（见下）与误用原生 `window.confirm`。

### 主题令牌（踩过的坑）

CSS 自定义属性写错**不会报错**，只会静默回退成继承色 —— 面板看起来「有点不对」但查不出原因。
实测光主题下：

- `--dsw-alias-state-warn-primary` ✅ 真实存在（`#f59e0b`）
- `--dsw-alias-state-warning-primary` ❌ 未定义

本插件里曾有两处误用了后者：`加载中` 状态的小圆点因此完全没有背景色。
现在统一写成回退链 `var(--dsw-alias-state-warn-primary,var(--dsw-alias-state-warning-primary,#f59e0b))`，
并由 `client-render.test.mjs` 对着白名单校验所有用到的令牌。

> 注意：主题令牌是运行时注入到 `<body>` 上的，不在 `document.documentElement`，
> 也不会出现在可枚举的 CSSOM 规则里 —— 想核对只能读 `getComputedStyle(document.body)`。

## Uninstall

```bash
dsh plugin --profile web remove dsh-mcp-market
```

你安装过的服务器会留在 `cordis.patch.yml` 里（它们就是普通的 DSH MCP 行）。
如果想留下一个干净的文件，先在「已安装」页把它们删掉。

## License

MIT
