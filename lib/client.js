/**
 * dsh-mcp-market —— 前端面板。
 *
 * 宿主以 `/plugins/dsh-mcp-market/client.js` 提供本文件，因此它是浏览器束：
 * 只能 require 外壳种子词（react / react/jsx-runtime / dsh-client-ui-primitives），
 * 不能 import 任何 Node 模块，也不能用 JSX 语法。
 *
 * 两个页签：
 *   · 广场   —— 浏览 / 搜索 / 筛选魔搭社区的服务，一键安装
 *   · 已安装 —— 管理本机 MCP 服务器：启停、测试连接、删除
 */

window.__ModuleLoader__.load({
  id: "dsh-mcp-market",
  factory: (require) => {
    const bundleModule = { exports: {} };
    Object.defineProperty(bundleModule.exports, Symbol.toStringTag, { value: "Module" });

    const jsxRuntime = require("react/jsx-runtime");
    const react = require("react");
    const primitives = require("@deepseek-ai/dsh-client-ui-primitives");

    const { useState, useEffect, useCallback, useMemo, useRef, Fragment } = react;
    const Button = primitives.Button;
    const Switch = primitives.Switch;
    const Tag = primitives.Tag;
    const Menu = primitives.Menu;
    const IconChevronDownOutlineRegular = primitives.IconChevronDownOutlineRegular;
    const IconSlidersTwoOutlineRegular = primitives.IconSlidersTwoOutlineRegular;

    /** 统一的元素构造：像 JSX 一样收尾，免去手工拼 children。 */
    const h = (tag, props, ...children) => {
      const flat = children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false);
      const merged = { ...(props || {}) };
      if (flat.length === 0) return jsxRuntime.jsx(tag, merged);
      if (flat.length === 1) {
        merged.children = flat[0];
        return jsxRuntime.jsx(tag, merged);
      }
      merged.children = flat;
      return jsxRuntime.jsxs(tag, merged);
    };

    const NS = "mcp-market";
    const MARKET_PANEL_ID = "mcp-market";

    // ───────────────────────── 文案 ─────────────────────────

    const zh = {
      nav: "MCP 广场",
      back: "返回会话",
      title: "MCP 广场",
      subtitle: "浏览魔搭社区的 MCP 服务，一键安装到本机；已装服务可随时启停或删除。",
      tabMarket: "广场",
      tabInstalled: "已安装",
      searchPlaceholder: "搜索名称、作者或用途…",
      sort: "排序",
      sortRelevance: "相关度",
      sortStars: "星标",
      sortViews: "热度",
      sortUpdated: "最近更新",
      all: "全部",
      hosted: "托管",
      local: "本地",
      refresh: "刷新",
      sync: "同步广场",
      syncing: "同步中…",
      addManual: "手动添加",
      addManualTitle: "手动添加 MCP 服务器",
      addManualHint: "自行填写命令行或服务地址，写入 cordis.patch.yml，由 DSH 热加载，无需重启。",
      transport: "调用方式",
      transportLocal: "本地命令",
      transportRemote: "远程地址",
      argsHint: "多个参数用空格分隔",
      cwd: "工作目录",
      cwdHint: "可选，留空则沿用当前目录",
      envAdd: "添加一项",
      envKey: "变量名",
      envValue: "值",
      removeRow: "移除这一行",
      confirmAdd: "添加",
      addOk: "已添加 {name}，工具将在片刻后可用。",
      addFail: "添加失败",
      noCache: "还没有本地索引，展示的是广场实时结果。点「同步广场」可拉取全量并支持分类筛选。",
      cacheInfo: "本地索引 {n} 条 · {time}",
      cacheInfoFull: "本地索引 {n} / {total} 条（{p}%）· {time}",
      indexCapped:
        "魔搭对未登录请求限制单次查询最多 300 条，本地索引因此覆盖 {p}%；搜索框会同时向广场发起实时查询以补全未收录的服务。",
      syncRequests: "请求 {n} 次",
      empty: "没有匹配的服务。",
      loading: "正在加载…",
      loadError: "加载失败",
      retry: "重试",
      loadMore: "加载更多",
      installedCount: "已安装 {n} 个服务",
      noInstalled: "还没有安装 MCP 服务。去「广场」逛逛。",
      install: "安装",
      installing: "安装中…",
      installed: "已安装",
      detail: "在魔搭查看",
      unsupported: "暂不支持",
      installTitle: "安装 {name}",
      installKindLocal: "本地运行",
      installKindRemote: "远程直连",
      serverName: "服务标识",
      serverNameHint: "工具会以 mcp__{name}__<工具名> 注册，只能是字母、数字、下划线或连字符。",
      command: "启动命令",
      args: "启动参数",
      url: "服务地址",
      envTitle: "环境变量",
      headersTitle: "请求头",
      headerAdd: "添加一项",
      headersHint: "需要鉴权的服务在这里填 Authorization，值形如 Bearer <token>。",
      envRequired: "必填",
      envOptional: "可选",
      cancel: "取消",
      confirmInstall: "确认安装",
      installOk: "已安装 {name}，工具将在片刻后可用。",
      installFail: "安装失败",
      remove: "删除",
      removeConfirm: "确定删除 {name}？该操作会从配置文件中移除它。",
      removing: "删除中…",
      removeOk: "已删除 {name}。",
      removeFail: "删除失败",
      test: "测试连接",
      testing: "测试中…",
      testOk: "连接成功，发现 {n} 个工具。",
      testFail: "连接失败",
      enable: "启用",
      toggleFail: "切换失败",
      external: "外部",
      externalHint: "由其它工具或手动写入，只能查看。",
      transportStdio: "stdio",
      transportHttp: "HTTP",
      tools: "{n} 个工具",
      requiresEnv: "需配置密钥",
      starUnit: "星标",
      syncTitle: "同步结果",
      syncAdded: "新增 {n}",
      syncUpdated: "更新 {n}",
      syncRemoved: "下架 {n}",
      syncUnchanged: "未变 {n}",
      syncOk: "同步完成：扫描 {n} 条，用时 {t}s。",
      syncFail: "同步失败",
      scheduleOn: "定时同步：每 {h} 小时",
      scheduleOff: "定时同步：已关闭",
      scheduleNext: "下次约 {time}",
      scheduleRunning: "后台同步中…",
      scheduleStartup: "启动自动同步",
      scheduleLast: "上次同步 {time}（{trigger}）",
      triggerManual: "手动",
      triggerAuto: "定时",
      triggerStartup: "启动",
      scheduleHint: "可在配置文件里改 autoSync / intervalHours。",
      patchPath: "配置文件",
      statusActive: "运行中",
      statusFailed: "启动失败",
      statusPending: "加载中",
      statusOff: "已停用",
      optionalAdvanced: "高级选项",
      preferLocal: "优先用本地命令运行",
    };

    const en = {
      nav: "MCP Market",
      back: "Back to chat",
      title: "MCP Market",
      subtitle: "Browse ModelScope MCP servers, install with one click, and manage what is installed.",
      tabMarket: "Market",
      tabInstalled: "Installed",
      searchPlaceholder: "Search by name, author or purpose…",
      sort: "Sort",
      sortRelevance: "Relevance",
      sortStars: "Stars",
      sortViews: "Popularity",
      sortUpdated: "Recently updated",
      all: "All",
      hosted: "Hosted",
      local: "Local",
      refresh: "Refresh",
      sync: "Sync catalog",
      syncing: "Syncing…",
      addManual: "Add manually",
      addManualTitle: "Add MCP server manually",
      addManualHint: "Enter a command line or an endpoint yourself. It is written to cordis.patch.yml and hot-loaded by DSH — no restart.",
      transport: "Transport",
      transportLocal: "Local command",
      transportRemote: "Remote endpoint",
      argsHint: "Separate multiple arguments with spaces",
      cwd: "Working directory",
      cwdHint: "Optional; defaults to the current directory",
      envAdd: "Add variable",
      envKey: "Name",
      envValue: "Value",
      removeRow: "Remove this row",
      confirmAdd: "Add",
      addOk: "Added {name}; tools will appear shortly.",
      addFail: "Add failed",
      noCache: "No local index yet — showing live results. Use “Sync catalog” to pull everything and enable category filters.",
      cacheInfo: "{n} indexed · {time}",
      cacheInfoFull: "{n} / {total} indexed ({p}%) · {time}",
      indexCapped:
        "ModelScope caps anonymous queries at 300 rows per query, so the local index covers {p}% of the catalogue. The search box also queries the marketplace live to reach servers outside the index.",
      syncRequests: "{n} requests",
      empty: "No matching servers.",
      loading: "Loading…",
      loadError: "Failed to load",
      retry: "Retry",
      loadMore: "Load more",
      installedCount: "{n} server(s) installed",
      noInstalled: "No MCP servers installed yet. Browse the market.",
      install: "Install",
      installing: "Installing…",
      installed: "Installed",
      detail: "View on ModelScope",
      unsupported: "Not supported",
      installTitle: "Install {name}",
      installKindLocal: "Run locally",
      installKindRemote: "Remote endpoint",
      serverName: "Server name",
      serverNameHint: "Tools register as mcp__{name}__<tool>. Letters, digits, underscore and hyphen only.",
      command: "Command",
      args: "Arguments",
      url: "Endpoint",
      envTitle: "Environment variables",
      headersTitle: "Request headers",
      headerAdd: "Add header",
      headersHint: "Endpoints that require auth expect an Authorization header, e.g. Bearer <token>.",
      envRequired: "required",
      envOptional: "optional",
      cancel: "Cancel",
      confirmInstall: "Install",
      installOk: "Installed {name}; tools will appear shortly.",
      installFail: "Install failed",
      remove: "Remove",
      removeConfirm: "Remove {name} from the config file?",
      removing: "Removing…",
      removeOk: "Removed {name}.",
      removeFail: "Remove failed",
      test: "Test",
      testing: "Testing…",
      testOk: "Connected — {n} tools found.",
      testFail: "Connection failed",
      enable: "Enable",
      toggleFail: "Toggle failed",
      external: "External",
      externalHint: "Written elsewhere; read-only here.",
      transportStdio: "stdio",
      transportHttp: "HTTP",
      tools: "{n} tool(s)",
      requiresEnv: "Needs secrets",
      starUnit: "Stars",
      syncTitle: "Sync result",
      syncAdded: "added {n}",
      syncUpdated: "updated {n}",
      syncRemoved: "removed {n}",
      syncUnchanged: "unchanged {n}",
      syncOk: "Sync done: scanned {n}, took {t}s.",
      syncFail: "Sync failed",
      scheduleOn: "Auto sync: every {h}h",
      scheduleOff: "Auto sync: off",
      scheduleNext: "next around {time}",
      scheduleRunning: "Syncing in background…",
      scheduleStartup: "Sync on startup",
      scheduleLast: "Last sync {time} ({trigger})",
      triggerManual: "manual",
      triggerAuto: "scheduled",
      triggerStartup: "startup",
      scheduleHint: "Change autoSync / intervalHours in the config file.",
      patchPath: "Config file",
      statusActive: "Running",
      statusFailed: "Failed",
      statusPending: "Loading",
      statusOff: "Disabled",
      optionalAdvanced: "Advanced",
      preferLocal: "Prefer running locally",
    };

    /**
     * 魔搭分类 slug → 展示名 `[中文, English]`。
     *
     * 列表接口只给英文 slug（`Data.FiledAgg.Category[].Value`），没有本地化字段；
     * 官网展示的中文来自前端 i18n 词条（`modelscope-fe` 语言包的 `MCPList.*`，
     * 只覆盖它自己展示的那 14 个分类）。前 14 项即官网官方译名，其余按语义补译，
     * 未收录的走 `titleize` 兜底。
     */
    const CATEGORY_NAMES = {
      "developer-tools": ["开发者工具", "Developer Tools"],
      "scientific-tool": ["科研工具", "Scientific Tool"],
      search: ["搜索工具", "Search Tools"],
      other: ["其他", "Other"],
      "calendar-management": ["日程管理", "Schedule Management"],
      "research-and-data": ["学术研究", "Academic Research"],
      "knowledge-and-memory": ["知识管理与记忆", "Knowledge Management and Memory"],
      "browser-automation": ["浏览器自动化", "Browser Automation"],
      communication: ["交流协作工具", "Communication and Collaboration"],
      databases: ["数据库", "Databases"],
      finance: ["金融", "Finance"],
      "app-automation": ["应用自动化", "App Automation"],
      "file-systems": ["文件系统", "File System"],
      "entertainment-and-media": ["娱乐与多媒体", "Entertainment and Multimedia"],
      "cloud-platforms": ["云平台", "Cloud Platforms"],
      "os-automation": ["系统自动化", "OS Automation"],
      "location-services": ["位置服务", "Location Services"],
      "rag-systems": ["RAG 系统", "RAG Systems"],
      "image-and-video-processing": ["图像与视频处理", "Image and Video Processing"],
      "autonomous-agents": ["自主智能体", "Autonomous Agents"],
      "note-taking": ["笔记与记录", "Note Taking"],
      "version-control": ["版本控制", "Version Control"],
      monitoring: ["监控告警", "Monitoring"],
      "agent-orchestration": ["智能体编排", "Agent Orchestration"],
      "security-and-iam": ["安全与权限", "Security and IAM"],
      "code-execution": ["代码执行", "Code Execution"],
      "content-management-systems": ["内容管理系统", "Content Management Systems"],
      "documentation-access": ["文档检索", "Documentation Access"],
      "art-and-culture": ["文化与艺术", "Culture and Arts"],
      "social-media": ["社交媒体", "Social Media"],
      "project-management": ["项目管理", "Project Management"],
      "code-analysis": ["代码分析", "Code Analysis"],
      "ecommerce-and-retail": ["电商零售", "E-commerce and Retail"],
      "multimedia-processing": ["多媒体处理", "Multimedia Processing"],
      "customer-data-platforms": ["客户数据平台", "Customer Data Platforms"],
      "travel-and-transportation": ["出行与交通", "Travel and Transportation"],
      marketing: ["市场营销", "Marketing"],
      "cloud-storage": ["云存储", "Cloud Storage"],
      "education-and-learning-tools": ["教育与学习", "Education and Learning"],
      "testing-and-qa-tools": ["测试与质量", "Testing and QA Tools"],
      "home-automation-and-iot": ["智能家居与 IoT", "Home Automation and IoT"],
      "shell-access": ["Shell 访问", "Shell Access"],
      "command-line": ["命令行", "Command Line"],
      "api-testing": ["接口测试", "API Testing"],
      "ci-cd": ["持续集成", "CI/CD"],
      "vector-databases": ["向量数据库", "Vector Databases"],
      "games-and-gamification": ["游戏与娱乐", "Games and Gamification"],
      "speech-processing": ["语音处理", "Speech Processing"],
      "health-and-wellness": ["健康与养生", "Health and Wellness"],
      "customer-and-marketing": ["客户与市场", "Customer and Marketing"],
      "text-summarization": ["文本摘要", "Text Summarization"],
      observability: ["可观测性", "Observability"],
      "data-platforms": ["数据平台", "Data Platforms"],
      "customer-support": ["客户支持", "Customer Support"],
      "open-data": ["开放数据", "Open Data"],
      blockchain: ["区块链", "Blockchain"],
      "government-data": ["政务数据", "Government Data"],
      "coding-agents": ["编码智能体", "Coding Agents"],
      "audio-processing": ["音频处理", "Audio Processing"],
      "penetration-testing": ["渗透测试", "Penetration Testing"],
      cryptocurrency: ["加密货币", "Cryptocurrency"],
      "language-translation": ["翻译", "Language Translation"],
      transportation: ["交通出行", "Transportation"],
      "text-to-speech": ["语音合成", "Text to Speech"],
      "erp-systems": ["ERP 系统", "ERP Systems"],
      "legal-and-compliance": ["法律合规", "Legal and Compliance"],
      "fitness-tracking": ["运动记录", "Fitness Tracking"],
      "biology-and-medicine": ["生物医学", "Biology and Medicine"],
      "software-architecture": ["软件架构", "Software Architecture"],
      AIGC: ["AIGC", "AIGC"],
      "home-automation": ["家居自动化", "Home Automation"],
      bioinformatics: ["生物信息", "Bioinformatics"],
      "real-estate": ["房产", "Real Estate"],
      security: ["安全", "Security"],
      sports: ["体育", "Sports"],
      productivity: ["效率工具", "Productivity"],
      education: ["教育", "Education"],
      "feature-flags": ["特性开关", "Feature Flags"],
      "health-and-fitness": ["健康健身", "Health and Fitness"],
      travel: ["旅行", "Travel"],
      // 以下几个是魔搭侧的历史拼写/大小写变体，归一到同一个中文名。
      "research-an-data": ["学术研究", "Academic Research"],
      "Research&Data": ["学术研究", "Academic Research"],
      data: ["数据", "Data"],
      religion: ["宗教", "Religion"],
      gaming: ["游戏", "Gaming"],
      "education-and-research": ["教育与科研", "Education and Research"],
      "fitness-and-sports": ["健身与运动", "Fitness and Sports"],
      "aerospace-and-astrodynamics": ["航空航天", "Aerospace and Astrodynamics"],
      "network-monitoring": ["网络监控", "Network Monitoring"],
      fitness: ["健身", "Fitness"],
      "travel-services": ["旅行服务", "Travel Services"],
      "Knowledge&Memory": ["知识管理", "Knowledge Management"],
      "sports-and-recreation": ["运动休闲", "Sports and Recreation"],
      energy: ["能源", "Energy"],
      "security-and-compliance": ["安全合规", "Security and Compliance"],
      "legal-and-government": ["法律与政务", "Legal and Government"],
      health: ["健康", "Health"],
      DeveloperTools: ["开发者工具", "Developer Tools"],
      "network-services": ["网络服务", "Network Services"],
      healthcare: ["医疗健康", "Healthcare"],
    };

    /** 分类词条的 i18n key（用 `:/.-&` 等一律折叠成 `_`，保证是合法标识符形态）。 */
    const catKey = (value) => `cat_${String(value).replace(/[^A-Za-z0-9]+/g, "_")}`;

    for (const [slug, names] of Object.entries(CATEGORY_NAMES)) {
      zh[catKey(slug)] = names[0];
      en[catKey(slug)] = names[1];
    }

    /** 未收录 slug 的兜底展示：`app-automation` → `App Automation`。 */
    const titleize = (value) =>
      String(value)
        .split(/[-_\s]+/)
        .filter(Boolean)
        .map((word) => (word === word.toUpperCase() ? word : word.charAt(0).toUpperCase() + word.slice(1)))
        .join(" ");

    /** 分类展示名：优先 i18n 词条，未收录时回退成可读形式。 */
    const categoryLabel = (t, value) => {
      const key = catKey(value);
      const text = t(key);
      return text === key ? titleize(value) : text;
    };

    /** 排序值 → i18n key。 */
    const SORT_LABEL_KEYS = {
      relevance: "sortRelevance",
      stars: "sortStars",
      views: "sortViews",
      updated: "sortUpdated",
    };

    /** 托管范围值 → i18n key（"all" 表示不筛）。 */
    const HOST_LABEL_KEYS = { all: "all", true: "hosted", false: "local" };

    const DICT = { zh, en };

    /** 取词条并做 {n} 之类的最小插值。 */
    const makeT = (dict) => (key, params) => {
      const raw = dict[key] !== undefined ? dict[key] : key;
      if (!params) return raw;
      return raw.replace(/\{(\w+)\}/g, (_, name) => (params[name] === undefined ? `{${name}}` : String(params[name])));
    };

    // ───────────────────────── 样式 ─────────────────────────

    const CSS = [
      ".MM_page{display:flex;flex-direction:column;gap:14px;padding:20px 24px;height:100%;box-sizing:border-box;overflow:hidden}",
      ".MM_top{display:flex;align-items:center;gap:10px}",
      ".MM_back{font:inherit;font-size:13px;color:var(--dsw-alias-label-secondary);background:0 0;border:none;padding:4px 8px;border-radius:6px;cursor:pointer}",
      ".MM_back:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
      ".MM_head{display:flex;flex-direction:column;gap:4px}",
      ".MM_title{margin:0;font-size:15px;font-weight:500;color:var(--dsw-alias-label-primary)}",
      ".MM_intro{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}",
      ".MM_bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
      ".MM_search{flex:1;min-width:180px}",
      ".MM_searchInput{width:100%;box-sizing:border-box;height:32px;font:inherit;font-size:13px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:0 10px;outline:none}",
      ".MM_searchInput::placeholder{color:var(--dsw-alias-label-tertiary)}",
      ".MM_searchInput:focus-visible{border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-state-business-primary) 18%,transparent)}",
      ".MM_caret{display:inline-flex;align-items:center;margin-left:1px;opacity:.6}",
      ".MM_starWrap{display:inline-flex;align-items:center;gap:3px;vertical-align:-1px}",
      ".MM_star{display:block;flex:none;opacity:.75}",
      ".MM_metaSep{margin:0 6px;opacity:.55}",
      ".MM_tabs{display:flex;gap:4px;border-bottom:0.5px solid var(--dsw-alias-border-l2)}",
      ".MM_tab{font:inherit;font-size:13px;color:var(--dsw-alias-label-secondary);background:0 0;border:none;border-bottom:2px solid transparent;padding:8px 12px;cursor:pointer}",
      ".MM_tab:hover{color:var(--dsw-alias-label-primary)}",
      ".MM_tab[data-active=true]{color:var(--dsw-alias-state-business-primary);border-bottom-color:var(--dsw-alias-state-business-primary);font-weight:500}",
      ".MM_chips{display:flex;gap:6px;flex-wrap:wrap;align-items:center}",
      ".MM_chip{font:inherit;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:3px 11px;cursor:pointer;white-space:nowrap}",
      ".MM_chip:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l1)}",
      ".MM_chip[data-active=true]{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 12%,transparent);border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary);font-weight:500}",
      ".MM_chipCount{color:var(--dsw-alias-label-tertiary);margin-left:4px}",
      ".MM_scroll{flex:1;min-height:0;overflow-y:auto;scrollbar-width:thin;padding-right:2px}",
      ".MM_list{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:10px;margin:0;padding:0;list-style:none}",
      ".MM_card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:10px;padding:12px;display:flex;flex-direction:column;gap:8px;min-width:0}",
      ".MM_cardTop{display:flex;align-items:flex-start;gap:8px;min-width:0}",
      ".MM_cardName{font-size:13px;font-weight:500;line-height:20px;color:var(--dsw-alias-label-primary);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}",
      ".MM_cardTags{display:flex;gap:4px;flex-wrap:wrap;flex:none}",
      ".MM_cardMeta{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".MM_cardDesc{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}",
      ".MM_cardActions{display:flex;align-items:center;gap:8px;margin-top:2px}",
      ".MM_spacer{flex:1}",
      ".MM_link{font-size:12px;color:var(--dsw-alias-label-tertiary);text-decoration:none}",
      ".MM_link:hover{color:var(--dsw-alias-state-business-primary)}",
      ".MM_note{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);margin:0}",
      ".MM_hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);margin:4px 0 0;padding:6px 10px;border-radius:6px;background:var(--dsw-alias-bg-layer-3);border-left:2px solid var(--dsw-alias-state-business-primary)}",
      ".MM_warn{font-size:12px;line-height:18px;color:var(--dsw-alias-state-warn-primary,var(--dsw-alias-state-warning-primary,#f59e0b));margin:0}",
      ".MM_confirm{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:2px;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-state-warn-tertiary,rgba(245,158,11,.14));border-left:2px solid var(--dsw-alias-state-warn-primary,var(--dsw-alias-state-warning-primary,#f59e0b))}",
      ".MM_confirmText{flex:1;min-width:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary)}",
      ".MM_err{font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary);margin:0;word-break:break-word}",
      ".MM_ok{font-size:12px;line-height:18px;color:var(--dsw-alias-state-success-primary);margin:0;word-break:break-word}",
      ".MM_center{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:40px 20px;text-align:center}",
      ".MM_row{display:flex;align-items:center;gap:8px}",
      // 键值对编辑行：两个输入框等分剩余宽度，删除按钮固定 28px。
      ".MM_kvRow{display:flex;align-items:center;gap:6px}",
      ".MM_kvRow>.MM_input{flex:1;min-width:0}",
      ".MM_rowDel{flex:none;width:28px;height:28px;padding:0;font:inherit;font-size:15px;line-height:1;color:var(--dsw-alias-label-tertiary);background:0 0;border:1px solid transparent;border-radius:6px;cursor:pointer}",
      ".MM_rowDel:hover{color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-interactive-bg-hover)}",
      ".MM_instHead{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
      ".MM_instName{font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary)}",
      ".MM_instPath{font-size:11px;color:var(--dsw-alias-label-tertiary);word-break:break-all;margin:0}",
      ".MM_overlay{position:fixed;inset:0;background:rgba(0,0,0,.32);display:flex;align-items:center;justify-content:center;z-index:60;padding:24px}",
      ".MM_dialog{background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;width:min(560px,100%);max-height:86vh;display:flex;flex-direction:column;overflow:hidden}",
      ".MM_dialogHead{padding:16px 18px 12px;border-bottom:0.5px solid var(--dsw-alias-border-l2);display:flex;flex-direction:column;gap:6px}",
      ".MM_dialogBody{padding:14px 18px;overflow-y:auto;display:flex;flex-direction:column;gap:14px;scrollbar-width:thin}",
      ".MM_dialogFoot{padding:12px 18px;border-top:0.5px solid var(--dsw-alias-border-l2);display:flex;align-items:center;gap:8px}",
      ".MM_field{display:flex;flex-direction:column;gap:5px}",
      ".MM_label{font-size:12px;color:var(--dsw-alias-label-secondary)}",
      ".MM_input{width:100%;box-sizing:border-box;height:32px;font:inherit;font-size:13px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:0 10px;outline:none}",
      ".MM_input:focus-visible{border-color:var(--dsw-alias-state-business-primary)}",
      // 命令行摘要框：视觉上与 .MM_input 同族（同背景/边框/圆角），但不设 max-height
      // 与 overflow —— 之前那版会被 flex 压缩而溢出，Chrome 于是在框里画出一条滚动条。
      ".MM_kv{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);border-radius:8px;padding:7px 10px;margin:0;font-family:ui-monospace,SFMono-Regular,Consolas,Menlo,monospace;font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;word-break:break-all;flex:none}",
      ".MM_badge{display:inline-flex;align-items:center;gap:4px;font-size:11px;line-height:16px;padding:1px 7px;border-radius:5px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);white-space:nowrap}",
      ".MM_dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-label-tertiary);flex:none}",
      ".MM_dot[data-state=active]{background:var(--dsw-alias-state-success-primary)}",
      ".MM_dot[data-state=failed]{background:var(--dsw-alias-state-error-primary)}",
      ".MM_dot[data-state=pending]{background:var(--dsw-alias-state-warn-primary,var(--dsw-alias-state-warning-primary,#f59e0b))}",
    ].join("");

    /** 注入样式（幂等）。 */
    const ensureStyle = (tagId) => {
      if (typeof document === "undefined") return;
      const existing = document.querySelector(`style[data-plugin-css="${tagId}"]`);
      if (existing) return;
      const tag = document.createElement("style");
      tag.setAttribute("data-plugin-css", tagId);
      tag.textContent = CSS;
      document.head.appendChild(tag);
    };

    // ───────────────────────── 图标 ─────────────────────────

    const MarketIcon = (props) =>
      h(
        "svg",
        { width: 16, height: 16, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true", ...props },
        h("path", {
          d: "M2.5 3.2h11v3.1a1.6 1.6 0 0 1-3.2 0V3.2h-4.6v3.1a1.6 1.6 0 0 1-3.2 0z",
          stroke: "currentColor",
          strokeWidth: 1.2,
          strokeLinejoin: "round",
        }),
        h("path", {
          d: "M3.6 7.5v5.3h8.8V7.5",
          stroke: "currentColor",
          strokeWidth: 1.2,
          strokeLinecap: "round",
          strokeLinejoin: "round",
        }),
      );

    // ───────────────────────── 小工具 ─────────────────────────

    /** 大数字压缩成 1.2k / 3.4m。 */
    const compact = (value) => {
      const n = Number(value) || 0;
      if (n >= 1e6) return `${(n / 1e6).toFixed(1)}m`;
      if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
      return String(n);
    };

    const timeText = (timestamp) => {
      if (!timestamp) return "-";
      try {
        return new Date(Number(timestamp)).toLocaleString();
      } catch {
        return "-";
      }
    };

    /** 统一的错误文案提取。 */
    const errorText = (error) => {
      if (error === null || error === undefined) return "";
      if (typeof error === "string") return error;
      if (typeof error === "object" && typeof error.message === "string") return error.message;
      return String(error);
    };

    // ───────────────────────── 远程调用贡献 ─────────────────────────

    // 客户端只做形状声明；真正的严格校验由服务端 manifest 承担。
    // 两代 harness 契约并存（旧版读 schema.parse，新版读 create().parse），
    // 同一对象同时带上二者即可，无需版本探测。
    const identity = (value) => value;
    const looseSchema = { parse: identity };
    const codec = (symbol) => ({ mode: "strict", typeSymbol: symbol, schema: looseSchema, create: () => looseSchema });
    const desc = (service, method, params) => ({
      id: `dsh-mcp-market#${service}/${method}`,
      service,
      namespace: service,
      method,
      invocation: { kind: "direct" },
      parameters: (params || []).map((name) => ({
        name,
        wire: name,
        source: "json",
        acceptsUndefined: true,
        codec: codec(`dsh-mcp-market#param`),
      })),
      result: codec("dsh-mcp-market#result"),
    });

    const CONTRIBUTION = {
      package: "dsh-mcp-market",
      descriptors: [
        desc("mcpMarket", "status", []),
        desc("mcpMarket", "search", ["payload"]),
        desc("mcpMarket", "categories", []),
        desc("mcpMarket", "sync", ["payload"]),
        desc("mcpMarket", "plan", ["payload"]),
        desc("mcpMarket", "detail", ["payload"]),
        desc("mcpInstaller", "list", []),
        // 注意：不要用 "install" / "remove"，它们是客户端命名空间服务的保留方法名。
        desc("mcpInstaller", "installServer", ["payload"]),
        desc("mcpInstaller", "installCustom", ["payload"]),
        desc("mcpInstaller", "removeServer", ["payload"]),
        desc("mcpInstaller", "setEnabled", ["payload"]),
        desc("mcpInstaller", "test", ["payload"]),
      ],
    };

    // ───────────────────────── 子组件 ─────────────────────────

    /**
     * 实心五角星。
     *
     * 主题图标集（`dsh-client-ui-primitives`）里没有星形，所以自绘一个；
     * 颜色走 `currentColor`，跟着所在行文字一起变。
     */
    const StarIcon = ({ size = 11 }) =>
      h(
        "svg",
        {
          className: "MM_star",
          width: size,
          height: size,
          viewBox: "0 0 16 16",
          "aria-hidden": "true",
          focusable: "false",
        },
        h("path", {
          d: "M8 1.6L9.59 5.82L14.09 6.02L10.57 8.83L11.76 13.18L8 10.7L4.24 13.18L5.43 8.83L1.91 6.02L6.41 5.82Z",
          fill: "currentColor",
        }),
      );

    /**
     * 把若干片段用中点连成一行。
     *
     * `array.join(" · ")` 的可渲染版本 —— 片段本身可以是元素（比如星标图标），
     * 而不再是纯字符串。
     */
    const separate = (parts) => {
      const out = [];
      parts.forEach((part, index) => {
        if (index > 0) out.push(h("span", { key: `sep_${index}`, className: "MM_metaSep" }, "·"));
        out.push(part);
      });
      return out;
    };

    /**
     * 工具栏下拉。
     *
     * 用 DSH 原生 `Menu` 而不是 `<select>` —— 原生下拉的控件外壳和弹出层都由
     * 操作系统绘制，跟旁边那排按钮不是一个视觉体系（用户反馈「不搭」）。
     * `portal` 是必须的：面板根节点带 `overflow:hidden`，就地渲染会被裁掉。
     */
    const ToolbarDropdown = ({ label, icon, items, selectedId, open, onToggle, onClose, onSelect }) =>
      h(Menu, {
        open,
        portal: true,
        selectedId,
        items,
        onSelect,
        onClose,
        anchor: h(
          Button,
          { variant: "outline", size: "sm", icon, onClick: onToggle },
          label,
          h("span", { className: "MM_caret" }, h(IconChevronDownOutlineRegular, { size: 14 })),
        ),
      });

    /** 服务卡片（广场页）。 */
    const ServiceCard = ({ server, t, busy, onInstall }) => {
      const kind = server.installKind;
      const canInstall = kind === "local" || kind === "remote";
      const metaParts = [];
      if (server.publisher) {
        metaParts.push(h("span", { key: "publisher" }, `@${server.publisher.split("/")[0].replace(/^@/, "")}`));
      }
      if (server.stars) {
        metaParts.push(
          h(
            "span",
            { key: "stars", className: "MM_starWrap", title: t("starUnit") },
            h(StarIcon, { size: 11 }),
            compact(server.stars),
          ),
        );
      }
      if (server.toolCount) metaParts.push(h("span", { key: "tools" }, t("tools", { n: server.toolCount })));

      return h(
        "li",
        { className: "MM_card" },
        h(
          "div",
          { className: "MM_cardTop" },
          h("span", { className: "MM_cardName", title: server.displayName }, server.displayName),
          h(
            "span",
            { className: "MM_cardTags" },
            server.hosted ? h(Tag, { tone: "info" }, t("hosted")) : null,
            server.verified ? h(Tag, { tone: "success" }, "✓") : null,
            server.installed ? h(Tag, { tone: "solid" }, t("installed")) : null,
          ),
        ),
        h("p", { className: "MM_cardMeta" }, ...separate(metaParts)),
        server.abstract ? h("p", { className: "MM_cardDesc", title: server.abstract }, server.abstract) : null,
        h(
          "div",
          { className: "MM_cardActions" },
          server.requiresEnv ? h("span", { className: "MM_badge" }, t("requiresEnv")) : null,
          !canInstall ? h("span", { className: "MM_warn" }, t("unsupported")) : null,
          h("span", { className: "MM_spacer" }),
          server.detailUrl
            ? h("a", { className: "MM_link", href: server.detailUrl, target: "_blank", rel: "noreferrer" }, t("detail"))
            : null,
          h(
            Button,
            { variant: "outline", size: "sm", disabled: !canInstall || server.installed || busy, onClick: () => onInstall(server) },
            server.installed ? t("installed") : busy ? t("installing") : t("install"),
          ),
        ),
      );
    };

    /**
     * 已安装卡片。
     *
     * 删除走「卡片内二次确认」而不是 `window.confirm`：原生 confirm 会同步阻塞
     * 渲染主线程，既打断面板自己的异步刷新，外观也和主题化的面板不搭。
     */
    const InstalledCard = ({ item, t, busy, confirming, onToggle, onAskRemove, onRemove, onCancelRemove, onTest, testState }) => {
      const state = !item.enabled ? "off" : item.fiberPhase === "active" ? "active" : item.fiberPhase === "failed" ? "failed" : "pending";
      const stateText =
        state === "active" ? t("statusActive") : state === "failed" ? t("statusFailed") : state === "off" ? t("statusOff") : t("statusPending");

      return h(
        "li",
        { className: "MM_card", "data-confirming": confirming ? "true" : undefined },
        h(
          "div",
          { className: "MM_cardTop" },
          h("span", { className: "MM_dot", "data-state": state }),
          h("span", { className: "MM_cardName", title: item.serverName }, item.serverName),
          h(
            "span",
            { className: "MM_cardTags" },
            h(Tag, { tone: item.transport === "stdio" ? "neutral" : "info" }, item.transport === "stdio" ? t("transportStdio") : t("transportHttp")),
            item.managed ? null : h(Tag, { tone: "outline" }, t("external")),
          ),
        ),
        h(
          "p",
          { className: "MM_cardMeta" },
          `${stateText} · ${item.enabled ? t("tools", { n: item.toolCount }) : "-"}`,
        ),
        item.transport === "stdio" && item.command
          ? h("p", { className: "MM_cardDesc" }, `${item.command} ${(item.args || []).join(" ")}`)
          : item.url
            ? h("p", { className: "MM_cardDesc" }, item.url)
            : null,
        item.envKeys && item.envKeys.length
          ? h("p", { className: "MM_cardMeta" }, `${t("envTitle")}: ${item.envKeys.join(", ")}`)
          : null,
        item.headerKeys && item.headerKeys.length
          ? h("p", { className: "MM_cardMeta" }, `${t("headersTitle")}: ${item.headerKeys.join(", ")}`)
          : null,
        confirming
          ? h(
              "div",
              { className: "MM_confirm" },
              h("span", { className: "MM_confirmText" }, t("removeConfirm", { name: item.serverName })),
              h(Button, { variant: "ghost", size: "sm", disabled: busy, onClick: () => onCancelRemove(item) }, t("cancel")),
              h(Button, { variant: "primary", size: "sm", disabled: busy, onClick: () => onRemove(item) }, t("remove")),
            )
          : h(
              "div",
              { className: "MM_cardActions" },
              h(Switch, {
                checked: item.enabled,
                disabled: busy || !item.managed,
                label: item.serverName,
                onChange: (next) => onToggle(item, next),
              }),
              h(Button, { variant: "ghost", size: "sm", disabled: busy, onClick: () => onTest(item) }, testState === "running" ? t("testing") : t("test")),
              h("span", { className: "MM_spacer" }),
              item.managed
                ? h(Button, { variant: "ghost", size: "sm", disabled: busy, onClick: () => onAskRemove(item) }, t("remove"))
                : null,
            ),
        testState === "ok" ? h("p", { className: "MM_ok" }, testState.text) : null,
        testState === "fail" ? h("p", { className: "MM_err" }, testState.text) : null,
      );
    };

    /** 安装确认弹窗。 */
    const InstallDialog = ({ plan, t, installing, error, onCancel, onConfirm }) => {
      const [name, setName] = useState(plan.serverName || "");
      const [env, setEnv] = useState(() => {
        const initial = {};
        for (const field of plan.envFields || []) initial[field.key] = "";
        return initial;
      });

      const isStdio = plan.config && plan.config.transport === "stdio";
      const summary = isStdio
        ? `${plan.config.command} ${(plan.config.args || []).join(" ")}`.trim()
        : String(plan.config?.url || "");

      return h(
        "div",
        { className: "MM_overlay", onClick: (event) => (event.target === event.currentTarget ? onCancel() : undefined) },
        h(
          "div",
          { className: "MM_dialog" },
          h(
            "div",
            { className: "MM_dialogHead" },
            h("span", { className: "MM_instName" }, t("installTitle", { name: plan.displayName || plan.serverName })),
            h("p", { className: "MM_note" }, plan.kind === "remote" ? t("installKindRemote") : t("installKindLocal")),
          ),
          h(
            "div",
            { className: "MM_dialogBody" },
            h(
              "div",
              { className: "MM_field" },
              h("span", { className: "MM_label" }, t("serverName")),
              h("input", { className: "MM_input", value: name, onChange: (event) => setName(event.target.value) }),
              h("p", { className: "MM_note" }, t("serverNameHint", { name: name || "…" })),
            ),
            h("pre", { className: "MM_kv" }, summary),
            (plan.envFields || []).length > 0
              ? h(
                  "div",
                  { className: "MM_field" },
                  h("span", { className: "MM_label" }, t("envTitle")),
                  ...plan.envFields.map((field) =>
                    h(
                      "div",
                      { className: "MM_field", key: field.key },
                      h(
                        "span",
                        { className: "MM_label" },
                        `${field.key}${field.required ? ` · ${t("envRequired")}` : ` · ${t("envOptional")}`}`,
                      ),
                      field.description ? h("p", { className: "MM_note" }, field.description) : null,
                      h("input", {
                        className: "MM_input",
                        value: env[field.key] || "",
                        placeholder: field.example || "",
                        onChange: (event) => setEnv((prev) => ({ ...prev, [field.key]: event.target.value })),
                      }),
                    ),
                  ),
                )
              : null,
            error ? h("p", { className: "MM_err" }, error) : null,
          ),
          h(
            "div",
            { className: "MM_dialogFoot" },
            h("span", { className: "MM_spacer" }),
            h(Button, { variant: "ghost", size: "sm", onClick: onCancel }, t("cancel")),
            h(
              Button,
              { variant: "primary", size: "sm", disabled: installing, onClick: () => onConfirm(name.trim(), env) },
              installing ? t("installing") : t("confirmInstall"),
            ),
          ),
        ),
      );
    };

    /**
     * 手动添加 MCP 服务器。
     *
     * 与 InstallDialog 分开写：那边是「广场给了一份 plan，确认一下」，字段只读；
     * 这边是空白表单，要切传输方式、拆参数、动态增删环境变量键值对，形态不同。
     * 两份配置最终走同一个 host 写入路径（查重 / 落盘 / 收敛都在 gateway 里）。
     */
    const CustomDialog = ({ t, submitting, error, onCancel, onSubmit }) => {
      const [serverName, setServerName] = useState("");
      const [transport, setTransport] = useState("stdio");
      const [command, setCommand] = useState("");
      const [argsText, setArgsText] = useState("");
      const [cwd, setCwd] = useState("");
      const [url, setUrl] = useState("");
      const [envRows, setEnvRows] = useState([{ key: "", value: "" }]);
      const [headerRows, setHeaderRows] = useState([{ key: "", value: "" }]);

      const isStdio = transport === "stdio";

      /** 收起成映射：键为空的行直接丢掉，省得写进配置里变成空字段。 */
      const collect = (rows) => {
        const out = {};
        for (const row of rows) {
          const key = row.key.trim();
          if (key !== "") out[key] = row.value;
        }
        return out;
      };

      const editorsFor = (setRows) => ({
        change: (index, patch) =>
          setRows((rows) => rows.map((row, at) => (at === index ? { ...row, ...patch } : row))),
        /** 删到只剩一行时保留一个空行，避免表单突然没有可填的输入框。 */
        remove: (index) =>
          setRows((rows) => {
            const next = rows.filter((_, at) => at !== index);
            return next.length > 0 ? next : [{ key: "", value: "" }];
          }),
        append: () => setRows((rows) => [...rows, { key: "", value: "" }]),
      });

      const envEditor = editorsFor(setEnvRows);
      const headerEditor = editorsFor(setHeaderRows);

      /** 键值对编辑区。环境变量与请求头共用同一套行式交互。 */
      const kvEditor = (options) =>
        h(
          "div",
          { className: "MM_field" },
          h("span", { className: "MM_label" }, `${options.title} · ${t("envOptional")}`),
          ...options.rows.map((row, index) =>
            h(
              "div",
              { className: "MM_kvRow", key: `${options.name}-${index}` },
              h("input", {
                className: "MM_input",
                value: row.key,
                placeholder: options.keyPlaceholder,
                "aria-label": `${options.title} ${t("envKey")}`,
                onChange: (event) => options.change(index, { key: event.target.value }),
              }),
              h("input", {
                className: "MM_input",
                value: row.value,
                placeholder: options.valuePlaceholder,
                "aria-label": `${options.title} ${t("envValue")}`,
                onChange: (event) => options.change(index, { value: event.target.value }),
              }),
              h(
                "button",
                {
                  className: "MM_rowDel",
                  type: "button",
                  title: t("removeRow"),
                  "aria-label": t("removeRow"),
                  onClick: () => options.remove(index),
                },
                "×",
              ),
            ),
          ),
          h(
            "div",
            null,
            h(
              Button,
              { variant: "ghost", size: "sm", onClick: options.append },
              `+ ${options.addLabel}`,
            ),
          ),
          ...(options.hint ? [h("p", { className: "MM_note" }, options.hint)] : []),
        );

      const submit = () => {
        onSubmit({
          serverName: serverName.trim(),
          transport,
          command: command.trim(),
          args: argsText.split(/\s+/).filter((item) => item !== ""),
          cwd: cwd.trim(),
          url: url.trim(),
          env: collect(envRows),
          headers: collect(headerRows),
        });
      };

      return h(
        "div",
        { className: "MM_overlay", onClick: (event) => (event.target === event.currentTarget ? onCancel() : undefined) },
        h(
          "div",
          { className: "MM_dialog" },
          h(
            "div",
            { className: "MM_dialogHead" },
            h("span", { className: "MM_instName" }, t("addManualTitle")),
            h("p", { className: "MM_note" }, t("addManualHint")),
          ),
          h(
            "div",
            { className: "MM_dialogBody" },
            h(
              "div",
              { className: "MM_field" },
              h("span", { className: "MM_label" }, t("serverName")),
              h("input", {
                className: "MM_input",
                value: serverName,
                placeholder: "my-server",
                onChange: (event) => setServerName(event.target.value),
              }),
              h("p", { className: "MM_note" }, t("serverNameHint", { name: serverName || "…" })),
            ),
            h(
              "div",
              { className: "MM_field" },
              h("span", { className: "MM_label" }, t("transport")),
              h(
                "div",
                { className: "MM_row" },
                h(
                  Button,
                  { variant: isStdio ? "primary" : "outline", size: "sm", onClick: () => setTransport("stdio") },
                  t("transportLocal"),
                ),
                h(
                  Button,
                  {
                    variant: isStdio ? "outline" : "primary",
                    size: "sm",
                    onClick: () => setTransport("streamable-http"),
                  },
                  t("transportRemote"),
                ),
              ),
            ),
            isStdio
              ? h(
                  Fragment,
                  null,
                  h(
                    "div",
                    { className: "MM_field" },
                    h("span", { className: "MM_label" }, t("command")),
                    h("input", {
                      className: "MM_input",
                      value: command,
                      placeholder: "npx",
                      onChange: (event) => setCommand(event.target.value),
                    }),
                  ),
                  h(
                    "div",
                    { className: "MM_field" },
                    h("span", { className: "MM_label" }, t("args")),
                    h("input", {
                      className: "MM_input",
                      value: argsText,
                      placeholder: "-y @modelcontextprotocol/server-filesystem /tmp",
                      onChange: (event) => setArgsText(event.target.value),
                    }),
                    h("p", { className: "MM_note" }, t("argsHint")),
                  ),
                  h(
                    "div",
                    { className: "MM_field" },
                    h("span", { className: "MM_label" }, `${t("cwd")} · ${t("envOptional")}`),
                    h("input", {
                      className: "MM_input",
                      value: cwd,
                      onChange: (event) => setCwd(event.target.value),
                    }),
                    h("p", { className: "MM_note" }, t("cwdHint")),
                  ),
                )
              : h(
                  "div",
                  { className: "MM_field" },
                  h("span", { className: "MM_label" }, t("url")),
                  h("input", {
                    className: "MM_input",
                    value: url,
                    placeholder: "https://example.com/mcp",
                    onChange: (event) => setUrl(event.target.value),
                  }),
                ),
            isStdio
              ? kvEditor({
                  name: "env",
                  title: t("envTitle"),
                  rows: envRows,
                  keyPlaceholder: t("envKey"),
                  valuePlaceholder: t("envValue"),
                  addLabel: t("envAdd"),
                  change: envEditor.change,
                  remove: envEditor.remove,
                  append: envEditor.append,
                })
              : kvEditor({
                  name: "header",
                  title: t("headersTitle"),
                  rows: headerRows,
                  keyPlaceholder: "Authorization",
                  valuePlaceholder: "Bearer <token>",
                  addLabel: t("headerAdd"),
                  hint: t("headersHint"),
                  change: headerEditor.change,
                  remove: headerEditor.remove,
                  append: headerEditor.append,
                }),
            error ? h("p", { className: "MM_err" }, error) : null,
          ),
          h(
            "div",
            { className: "MM_dialogFoot" },
            h("span", { className: "MM_spacer" }),
            h(Button, { variant: "ghost", size: "sm", onClick: onCancel }, t("cancel")),
            h(
              Button,
              { variant: "primary", size: "sm", disabled: submitting, onClick: submit },
              submitting ? t("installing") : t("confirmAdd"),
            ),
          ),
        ),
      );
    };

    // ───────────────────────── 主页面 ─────────────────────────

    const MarketPage = (props) => {
      const t = props.t;
      const mt = props.mt;

      const [tab, setTab] = useState("market");
      const [query, setQuery] = useState("");
      const [debounced, setDebounced] = useState("");
      const [sort, setSort] = useState("relevance");
      const [category, setCategory] = useState("");
      const [hostedOnly, setHostedOnly] = useState(undefined);
      /** 当前展开的下拉（"" = 全部收起）。排序与范围共用一个，天然互斥。 */
      const [openMenu, setOpenMenu] = useState("");

      const [servers, setServers] = useState([]);
      const [categories, setCategories] = useState([]);
      const [total, setTotal] = useState(0);
      const [source, setSource] = useState("");
      const [cachedAt, setCachedAt] = useState(0);
      const [page, setPage] = useState(1);
      const [loading, setLoading] = useState(false);
      const [error, setError] = useState("");
      const [syncing, setSyncing] = useState(false);
      const [syncNote, setSyncNote] = useState("");
      const [status, setStatus] = useState(undefined);

      const [installed, setInstalled] = useState([]);
      const [installedPath, setInstalledPath] = useState("");
      const [installedError, setInstalledError] = useState("");
      const [busyName, setBusyName] = useState("");
      /** 正在等待删除确认的 serverName（空串表示没有）。 */
      const [confirmRemove, setConfirmRemove] = useState("");
      const [testState, setTestState] = useState({});

      const [dialog, setDialog] = useState(undefined);
      const [installing, setInstalling] = useState(false);
      const [dialogError, setDialogError] = useState("");
      /** 手动添加对话框的开关与错误（与上面的 dialog 分开，两者不会同时打开）。 */
      const [customOpen, setCustomOpen] = useState(false);
      const [customError, setCustomError] = useState("");
      const [toast, setToast] = useState("");

      const PAGE_SIZE = 24;

      // 输入防抖，避免每敲一个字就重查。
      useEffect(() => {
        const timer = setTimeout(() => setDebounced(query), 260);
        return () => clearTimeout(timer);
      }, [query]);

      const flash = useCallback((message) => {
        setToast(message);
        setTimeout(() => setToast(""), 4000);
      }, []);

      const loadMarket = useCallback(
        async (nextPage) => {
          setLoading(true);
          setError("");
          try {
            const result = await props.api.search({
              query: debounced,
              category,
              hosted: hostedOnly,
              sort,
              pageNumber: nextPage,
              pageSize: PAGE_SIZE,
            });
            setServers((prev) => (nextPage > 1 ? [...prev, ...(result.servers || [])] : result.servers || []));
            setTotal(result.totalCount || 0);
            setCategories(result.categories || []);
            setSource(result.source || "");
            setCachedAt(result.cachedAt || 0);
            setPage(nextPage);
          } catch (err) {
            setError(errorText(err));
          } finally {
            setLoading(false);
          }
        },
        [props.api, debounced, category, hostedOnly, sort],
      );

      const loadInstalled = useCallback(async () => {
        try {
          const result = await props.api.list();
          const servers = result.servers || [];
          setInstalled(servers);
          setInstalledPath((result.patch || {}).path || "");
          setInstalledError((result.patch || {}).error || "");
          return servers;
        } catch (err) {
          setInstalledError(errorText(err));
          return [];
        }
      }, [props.api]);

      /** 组件是否仍挂载：收敛轮询是异步的，卸载后不该再 setState。 */
      const aliveRef = useRef(true);
      useEffect(() => {
        aliveRef.current = true;
        return () => {
          aliveRef.current = false;
        };
      }, []);

      /**
       * 写 patch 后的「状态收敛」刷新。
       *
       * 启停/安装只是改了配置文件，真正的进程拉起要等 HMR + MCP 握手，
       * 宿主侧最多只等 5 秒就放弃。这段窗口里 list() 会抓到
       * 「加载中 · 0 个工具」，然后一直停在那儿直到用户手点刷新。
       *
       * 按条件收敛而不是按固定次数：MCP 冷启动（npx 首次解析）实测可能超过
       * 10 秒，写死几轮会刚好错过；反过来状态瞬间就绪时也不该白等 20 秒。
       * 所以「还有 pending 就继续，全部落定就立刻停，最多 25 秒」。
       */
      const settleInstalled = useCallback(async ({ timeoutMs = 25000, intervalMs = 1200 } = {}) => {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
          const servers = await loadInstalled();
          const stillPending = servers.some(
            (item) => item.enabled && item.fiberPhase !== "active" && item.fiberPhase !== "failed",
          );
          if (!stillPending || !aliveRef.current || Date.now() >= deadline) return;
          await new Promise((resolve) => setTimeout(resolve, intervalMs));
          if (!aliveRef.current) return;
        }
      }, [loadInstalled]);

      // 调度状态（定时同步开关、上次/下次时间）。读不到就不显示，不影响主流程。
      const loadStatus = useCallback(async () => {
        try {
          setStatus(await props.api.status());
        } catch {
          setStatus(undefined);
        }
      }, [props.api]);

      // 条件变化时重查（回到第一页）。
      useEffect(() => {
        if (tab !== "market") return;
        loadMarket(1);
      }, [tab, loadMarket]);

      useEffect(() => {
        loadInstalled();
      }, [loadInstalled]);

      // 后台定时同步可能随时改数据，面板每 60s 刷一次状态；卸载时清掉计时器。
      useEffect(() => {
        loadStatus();
        const timer = setInterval(loadStatus, 60000);
        return () => clearInterval(timer);
      }, [loadStatus]);

      /** 托管范围下拉当前值："all" / "true" / "false"。 */
      const hostValue = hostedOnly === undefined ? "all" : String(hostedOnly);

      /** 组装调度说明文案；没有状态时返回空串（整行不渲染）。 */
      const scheduleText = () => {
        const schedule = status && status.schedule;
        if (!schedule) return "";
        if (schedule.running) return t("scheduleRunning");
        if (schedule.autoSync !== true) return `${t("scheduleOff")}　·　${t("scheduleHint")}`;
        const parts = [t("scheduleOn", { h: schedule.intervalHours })];
        if (schedule.nextRunAt) parts.push(t("scheduleNext", { time: timeText(schedule.nextRunAt) }));
        const last = schedule.lastRunAt || (status.lastSync && status.lastSync.at);
        const trigger = schedule.lastResult?.trigger || (status.lastSync && status.lastSync.trigger);
        if (last) parts.push(t("scheduleLast", { time: timeText(last), trigger: t(`trigger${trigger === "auto" ? "Auto" : trigger === "startup" ? "Startup" : "Manual"}`) }));
        return parts.join("　·　");
      };

      const doSync = async () => {
        setSyncing(true);
        setSyncNote("");
        try {
          const result = await props.api.sync({});
          setSyncNote(
            `${t("syncOk", { n: result.scanned, t: Math.round((result.elapsedMs || 0) / 100) / 10 })}　` +
              `${t("syncAdded", { n: result.added })} · ${t("syncUpdated", { n: result.updated })} · ${t("syncRemoved", { n: result.removed })}` +
              (result.requests ? ` · ${t("syncRequests", { n: result.requests })}` : ""),
          );
          await Promise.all([loadMarket(1), loadStatus()]);
        } catch (err) {
          setSyncNote(`${t("syncFail")}：${errorText(err)}`);
        } finally {
          setSyncing(false);
        }
      };

      const openInstall = async (server) => {
        setDialogError("");
        try {
          const plan = await props.api.plan({ publisher: server.publisher, preferLocal: false });
          if (plan.ok !== true) {
            flash(`${t("installFail")}：${plan.reason || ""}`);
            return;
          }
          setDialog(plan);
        } catch (err) {
          flash(`${t("installFail")}：${errorText(err)}`);
        }
      };

      const confirmInstall = async (serverName, env) => {
        setInstalling(true);
        setDialogError("");
        try {
          await props.api.install({ publisher: dialog.publisher, serverName, env });
          setDialog(undefined);
          flash(t("installOk", { name: dialog.displayName || serverName }));
          await loadMarket(1);
          // 进程拉起要等 HMR + MCP 握手，放后台收敛，不占着弹窗和按钮。
          void settleInstalled();
        } catch (err) {
          setDialogError(errorText(err));
        } finally {
          setInstalling(false);
        }
      };

      /**
       * 手动添加：表单已经整理成 host 需要的形状，这里只负责调用与收尾。
       *
       * 添加后切到「已安装」，用户能立刻看到新行以及它的启动状态 —— 冷启动一个
       * MCP 进程要等 npx 解析，通常要好几秒，停在原页面会以为没生效。
       */
      const addCustom = async (payload) => {
        setInstalling(true);
        setCustomError("");
        try {
          await props.api.installCustom(payload);
          setCustomOpen(false);
          flash(t("addOk", { name: payload.serverName }));
          setTab("installed");
          await Promise.all([loadInstalled(), loadMarket(1)]);
          void settleInstalled();
        } catch (err) {
          setCustomError(errorText(err));
        } finally {
          setInstalling(false);
        }
      };

      const toggle = async (item, next) => {
        setBusyName(item.serverName);
        try {
          await props.api.setEnabled({ serverName: item.serverName, enabled: next });
          await loadInstalled();
        } catch (err) {
          flash(`${t("toggleFail")}：${errorText(err)}`);
          await loadInstalled();
        } finally {
          setBusyName("");
        }
        void settleInstalled();
      };

      /** 第一次点击：只切到确认态，不动配置文件。 */
      const askRemove = (item) => {
        setConfirmRemove(item.serverName);
      };

      const cancelRemove = () => {
        setConfirmRemove("");
      };

      /** 第二次点击：真正删除。 */
      const remove = async (item) => {
        setConfirmRemove("");
        setBusyName(item.serverName);
        try {
          await props.api.remove({ serverName: item.serverName });
          flash(t("removeOk", { name: item.serverName }));
          await Promise.all([loadInstalled(), loadMarket(1)]);
        } catch (err) {
          flash(`${t("removeFail")}：${errorText(err)}`);
          await loadInstalled();
        } finally {
          setBusyName("");
        }
      };

      const test = async (item) => {
        setTestState((prev) => ({ ...prev, [item.serverName]: "running" }));
        try {
          const result = await props.api.test({ serverName: item.serverName });
          setTestState((prev) => ({
            ...prev,
            [item.serverName]: result.ok
              ? { state: "ok", text: t("testOk", { n: (result.tools || []).length }) }
              : { state: "fail", text: `${t("testFail")}：${result.error || ""}` },
          }));
        } catch (err) {
          setTestState((prev) => ({ ...prev, [item.serverName]: { state: "fail", text: `${t("testFail")}：${errorText(err)}` } }));
        }
      };

      const hasMore = servers.length < total;

      /**
       * 索引状态行。
       *
       * 魔搭对匿名请求限制「单次查询最多 300 条」，所以本地索引天然拿不满全量；
       * 与其含糊地说「300 条」，不如把覆盖率和原因讲清楚。覆盖率取 status
       * （对应整份缓存），不是当前筛选结果的 total。
       */
      const indexLine = () => {
        const cachedCount = status && status.cachedCount;
        const totalAll = status && status.totalCount;
        const realTime = cachedAt || (status && status.fetchedAt);

        if (!cachedCount || !totalAll) {
          return realTime
            ? h("p", { className: "MM_note" }, t("cacheInfo", { n: total, time: timeText(realTime) }))
            : source === "live"
              ? h("p", { className: "MM_note" }, t("noCache"))
              : null;
        }

        const percent = Math.round((cachedCount / totalAll) * 100);
        return h(
          Fragment,
          null,
          h(
            "p",
            { className: "MM_note" },
            t("cacheInfoFull", {
              n: compact(cachedCount),
              total: compact(totalAll),
              p: percent,
              time: timeText(realTime),
            }),
          ),
          cachedCount < totalAll ? h("p", { className: "MM_hint" }, t("indexCapped", { p: percent })) : null,
        );
      };

      const marketTab = () =>
        h(
          Fragment,
          null,
          indexLine(),
          categories.length
            ? h(
                "div",
                { className: "MM_chips" },
                h("button", { className: "MM_chip", "data-active": category === "", onClick: () => setCategory("") }, t("all")),
                ...categories
                  .slice()
                  .sort((a, b) => (b.Count || 0) - (a.Count || 0))
                  .slice(0, 14)
                  .map((item) =>
                    h(
                      "button",
                      {
                        key: item.Value,
                        className: "MM_chip",
                        "data-active": category === item.Value,
                        title: item.Value,
                        onClick: () => setCategory(category === item.Value ? "" : item.Value),
                      },
                      categoryLabel(t, item.Value),
                      h("span", { className: "MM_chipCount" }, compact(item.Count)),
                    ),
                  ),
              )
            : null,
          error
            ? h("div", { className: "MM_center" }, h("p", { className: "MM_err" }, `${t("loadError")}：${error}`), h(Button, { variant: "outline", size: "sm", onClick: () => loadMarket(1) }, t("retry")))
            : loading && servers.length === 0
              ? h("div", { className: "MM_center" }, h("p", { className: "MM_note" }, t("loading")))
              : servers.length === 0
                ? h("div", { className: "MM_center" }, h("p", { className: "MM_note" }, t("empty")))
                : h(
                    Fragment,
                    null,
                    h(
                      "ul",
                      { className: "MM_list" },
                      ...servers.map((server) =>
                        h(ServiceCard, {
                          key: server.publisher,
                          server,
                          t,
                          busy: installing,
                          onInstall: openInstall,
                        }),
                      ),
                    ),
                    hasMore
                      ? h(
                          "div",
                          { className: "MM_center" },
                          h(Button, { variant: "outline", size: "sm", disabled: loading, onClick: () => loadMarket(page + 1) }, loading ? t("loading") : t("loadMore")),
                        )
                      : null,
                  ),
        );

      const installedTab = () =>
        installed.length === 0
          ? h(
              "div",
              { className: "MM_center" },
              installedError ? h("p", { className: "MM_err" }, installedError) : h("p", { className: "MM_note" }, t("noInstalled")),
            )
          : h(
              Fragment,
              null,
              h("p", { className: "MM_note" }, `${t("installedCount", { n: installed.length })}${installedPath ? `　·　${t("patchPath")}: ${installedPath}` : ""}`),
              h(
                "ul",
                { className: "MM_list" },
                ...installed.map((item) =>
                  h(InstalledCard, {
                    key: item.serverName,
                    item,
                    t,
                    busy: busyName === item.serverName,
                    confirming: confirmRemove === item.serverName,
                    testState: testState[item.serverName],
                    onToggle: toggle,
                    onAskRemove: askRemove,
                    onRemove: remove,
                    onCancelRemove: cancelRemove,
                    onTest: test,
                  }),
                ),
              ),
            );

      return h(
        "div",
        { className: "MM_page" },
        h("div", { className: "MM_top" }, h("button", { className: "MM_back", onClick: props.backToConversation }, `← ${t("back")}`)),
        h(
          "div",
          { className: "MM_head" },
          h("h2", { className: "MM_title" }, t("title")),
          h("p", { className: "MM_intro" }, t("subtitle")),
        ),
        h(
          "div",
          { className: "MM_bar" },
          h(
            "span",
            { className: "MM_search" },
            h("input", {
              className: "MM_searchInput",
              value: query,
              placeholder: t("searchPlaceholder"),
              onChange: (event) => setQuery(event.target.value),
            }),
          ),
          h(ToolbarDropdown, {
            label: t(SORT_LABEL_KEYS[sort]),
            icon: h(IconSlidersTwoOutlineRegular, { size: 14 }),
            open: openMenu === "sort",
            selectedId: sort,
            items: [
              { id: "relevance", label: t("sortRelevance") },
              { id: "stars", label: t("sortStars"), icon: h(StarIcon, { size: 12 }) },
              { id: "views", label: t("sortViews") },
              { id: "updated", label: t("sortUpdated") },
            ],
            onToggle: () => setOpenMenu((current) => (current === "sort" ? "" : "sort")),
            onClose: () => setOpenMenu((current) => (current === "sort" ? "" : current)),
            onSelect: (id) => {
              setOpenMenu("");
              setSort(id);
            },
          }),
          h(ToolbarDropdown, {
            label: t(HOST_LABEL_KEYS[hostValue]),
            open: openMenu === "host",
            selectedId: hostValue,
            items: [
              { id: "all", label: t("all") },
              { id: "true", label: t("hosted") },
              { id: "false", label: t("local") },
            ],
            onToggle: () => setOpenMenu((current) => (current === "host" ? "" : "host")),
            onClose: () => setOpenMenu((current) => (current === "host" ? "" : current)),
            onSelect: (id) => {
              setOpenMenu("");
              setHostedOnly(id === "all" ? undefined : id === "true");
            },
          }),
          h(Button, { variant: "ghost", size: "sm", onClick: () => (tab === "market" ? loadMarket(1) : loadInstalled()) }, t("refresh")),
          h(Button, { variant: "outline", size: "sm", disabled: syncing, onClick: doSync }, syncing ? t("syncing") : t("sync")),
          h(
            Button,
            {
              variant: "outline",
              size: "sm",
              onClick: () => {
                setCustomError("");
                setCustomOpen(true);
              },
            },
            t("addManual"),
          ),
        ),
        scheduleText() ? h("p", { className: "MM_note" }, scheduleText()) : null,
        syncNote ? h("p", { className: syncNote.includes(t("syncFail")) ? "MM_err" : "MM_ok" }, syncNote) : null,
        toast ? h("p", { className: "MM_ok" }, toast) : null,
        h(
          "div",
          { className: "MM_tabs" },
          h("button", { className: "MM_tab", "data-active": tab === "market", onClick: () => setTab("market") }, t("tabMarket")),
          h("button", { className: "MM_tab", "data-active": tab === "installed", onClick: () => setTab("installed") }, t("tabInstalled")),
        ),
        h("div", { className: "MM_scroll" }, tab === "market" ? marketTab() : installedTab()),
        dialog
          ? h(InstallDialog, {
              plan: dialog,
              t,
              installing,
              error: dialogError,
              onCancel: () => setDialog(undefined),
              onConfirm: confirmInstall,
            })
          : null,
        customOpen
          ? h(CustomDialog, {
              t,
              submitting: installing,
              error: customError,
              onCancel: () => setCustomOpen(false),
              onSubmit: addCustom,
            })
          : null,
      );
    };

    // ───────────────────────── 插件体 ─────────────────────────

    const inject = ["slots", "locale", "remote", "layout"];

    function apply(ctx) {
      ensureStyle("dsh-mcp-market");
      ctx.effect(() => ctx.locale.register(NS, DICT), "dsh-mcp-market: dictionaries");

      const t = ctx.locale.bind(NS);
      const mt = ctx.locale.bind(NS);

      const mount = ctx.remote.$mount(CONTRIBUTION);

      /** 调用 host 侧服务；失败时把结构化错误翻译成异常。 */
      const call = async (service, method, ...args) => {
        await mount;
        const remote = ctx.get(`remote.${service}`);
        const result = await remote[method](...args);
        if (!result || result.ok !== true) {
          const code = result && result.error ? result.error.code : "unknown";
          const message = result && result.error ? result.error.message : "调用失败";
          throw new Error(`${service}.${method}: ${code}: ${message}`);
        }
        return result.value;
      };

      const api = {
        status: () => call("mcpMarket", "status"),
        search: (payload) => call("mcpMarket", "search", payload),
        categories: () => call("mcpMarket", "categories"),
        sync: (payload) => call("mcpMarket", "sync", payload),
        plan: (payload) => call("mcpMarket", "plan", payload),
        detail: (payload) => call("mcpMarket", "detail", payload),
        list: () => call("mcpInstaller", "list"),
        // 对外仍叫 install / remove，只把线上的方法名换成保留字安全的名字。
        install: (payload) => call("mcpInstaller", "installServer", payload),
        installCustom: (payload) => call("mcpInstaller", "installCustom", payload),
        remove: (payload) => call("mcpInstaller", "removeServer", payload),
        setEnabled: (payload) => call("mcpInstaller", "setEnabled", payload),
        test: (payload) => call("mcpInstaller", "test", payload),
      };

      const backToConversation = () => {
        const layout = ctx.get("layout");
        if (layout && typeof layout.selectPanel === "function") layout.selectPanel(null);
      };

      const sectionFace = () => ({ backToConversation, api });

      const MarketPanelPage = (pageProps) =>
        h("div", { className: "MM_page" }, h(MarketPage, { ...pageProps, api, backToConversation, t: mt, mt }));

      ctx.slots.inject("sidebar.panellist", () =>
        ctx.slots.register(
          {
            name: "sidebar.panellist",
            id: MARKET_PANEL_ID,
            order: 3,
            label: () => t("nav"),
            locale: NS,
          },
          MarketIcon,
        ),
      );

      ctx.slots.inject("main", () =>
        ctx.slots.register({ name: "main", key: MARKET_PANEL_ID, locale: NS, inject: sectionFace }, MarketPanelPage),
      );
    }

    bundleModule.exports.NS = NS;
    bundleModule.exports.apply = apply;
    bundleModule.exports.inject = inject;
    // 离线测试用的纯查表（宿主只读 apply / inject / NS，多挂这两个不影响它）。
    bundleModule.exports.CATEGORY_NAMES = CATEGORY_NAMES;
    bundleModule.exports.categoryLabel = categoryLabel;
    return bundleModule.exports;
  },
});
