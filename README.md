<div align="center">

# dsh-mcp-market

**Browse, scan and sync the ModelScope MCP marketplace inside DeepSeek Harness — then install, enable, disable or remove MCP servers with one click.**

</div>

---

`dsh-mcp-market` adds an **MCP Market** panel to the DSH Web sidebar. It pulls the server catalogue
from [modelscope.cn/mcp](https://modelscope.cn/mcp) (12,000+ services), translates each record into a
DSH-compatible MCP configuration, and writes it into your profile's `cordis.patch.yml` — where DSH
hot-reloads it via HMR, no restart required.

[English](README.md) · [简体中文](README-zh.md)

## Features

- 🛒 **Market tab** — search, sort (relevance / stars / popularity / recently updated), filter by
  category and by hosted-vs-local, then install. Category names come from ModelScope's own Chinese
  labels (the API returns English slugs only; the Chinese names live in the site's i18n dictionary and
  all 100 categories are bundled) — hover a chip to see the raw slug. Sort and filter use DSH's native
  dropdown menu, so they match the neighbouring buttons.
- 📦 **Installed tab** — see every MCP server in your profile with its live state
  (running / failed / loading / disabled), registered tool count, and per-server actions:
  enable, disable, test connection, remove. Removal asks for confirmation **inline in the card**
  rather than via `window.confirm` — the native dialog blocks the renderer thread and looks out of
  place in a themed panel. After an install or a toggle, the card settles to its final state on its
  own; no manual refresh needed.
- 🔄 **Catalog sync** — build a local index so search, sorting and category filters work without
  hitting the network on every keystroke. ModelScope caps anonymous queries at 300 rows, so the sync
  walks a keyword fan-out (~160 requests) and reaches ~67% of the 12,500-service catalogue; the panel
  reports the real coverage instead of pretending the index is complete. Incremental diffs report what
  was added / updated / delisted since the last sync.
  Search closes the remaining gap: typing a query also hits the marketplace live and merges the hits.
- ⏱ **Scheduled sync** — a manual "Sync catalog" button *plus* automatic refresh: the index is
  re-pulled on an interval, and a catch-up sync runs at startup when the cache is missing or
  stale. Both are configurable, and the panel shows when the last and next sync will happen.
- 🔐 **No ModelScope account needed** — the public catalogue API requires no login, and about 76% of
  indexed services ship a configuration that DSH can use directly (8,377-record measurement; see below).
- 🩺 **Pre-flight test** — spin up a connection and list its tools *before* committing anything to
  your config file.
- ✍️ **Add manually** — for servers that are not in the catalogue, or whose fields do not line up,
  fill in the panel directly: server name, transport (local command vs. remote endpoint), command
  and arguments (or endpoint). Local commands take environment variables; remote endpoints take
  request headers (e.g. `Authorization: Bearer <token>`) — both as add/drop key-value rows.
  It goes through the **same write path** as a catalogue install — same duplicate and clash checks,
  same managed block, hot-loaded by DSH with no restart.
- 🤝 **Plays well with others** — this plugin only ever rewrites its own marked block in
  `cordis.patch.yml`. Other plugins' rows (including `dsh-skill-mcp-panel`) are preserved byte for byte.

## Install

```bash
dsh plugin --profile <profile> add dsh-mcp-market
```

Or from a tarball:

```bash
dsh plugin --profile <profile> add ./dsh-mcp-market-0.1.0.tgz
```

The bundle patch mounts the plugin automatically — no manual `cordis.patch.yml` editing.
Restart that profile once, then open **MCP Market** in the left sidebar.

> **On pnpm 9:** if the install fails with
> `ERR_PNPM_ADDING_TO_ROOT — Running this command will add the dependency to the workspace root`,
> the profile directory contains a DSH-generated `pnpm-workspace.yaml` (`packages: [.]`) which pnpm
> treats as a workspace root. Do what the message says and add `-w`:
>
> ```bash
> dsh plugin --profile <profile> add -w dsh-mcp-market
> ```
>
> pnpm 10+ dropped this check, so you will not hit it there. It is a pnpm/DSH interaction, unrelated
> to this plugin.

## How it works

```
Market panel (browser)
   │  Typert Remote
   ▼
Cordis host plugin
   ├─ mcpMarket     ── ModelScope API ──▶ local index cache
   └─ mcpInstaller  ──▶ cordis.patch.yml managed block ──▶ @deepseek-ai/dsh-mcp-client (HMR)
```

**One MCP server is one row** in `~/.dsh/profiles/<profile>/cordis.patch.yml`:

```yaml
- id: mcp-market-<serverName>
  name: "@deepseek-ai/dsh-mcp-client"
  # disabled: true          # ← "disable" is exactly this flag
  config:
    serverName: <serverName>
    transport: stdio | streamable-http
```

So installing appends a row, removing drops one, and disabling sets `disabled: true`. Edits take
effect through HMR.

### Configuration mapping

| ModelScope field | DSH config |
|---|---|
| `StreamableHTTPServerConfig` | `transport: streamable-http` + `url` (+ `headers`) |
| `ServerConfig` | `transport: stdio` + `command` / `args` / `env` |
| `SSEServerConfig` | *not supported* — DSH has no SSE transport; the panel marks these "unsupported" |
| `EnvSchema` | rendered as an install-time form; placeholder values like `<required>` are never written |

Priority is remote → local. Measured across the whole 8,377-record index:

| Config found | Share |
|---|---|
| `ServerConfig` (local, stdio) | 67.5% |
| `StreamableHTTPServerConfig` (direct endpoint) | 8.4% |
| `SSEServerConfig` only → **not installable** | 24.1% |

**75.9% of indexed services are installable**; 23.4% of them need at least one environment variable.

> ModelScope *hosted* deployments (`DeployedUrl`) require a signed-in account and return an SSE
> address, which DSH cannot use. This plugin deliberately does not support them — local and direct
> connections cover the majority of the catalogue without any credentials.

### Why the index stops at ~67%, and what the sync actually does

The public catalogue API enforces an **offset cap of 300 for anonymous requests**: once
`(PageNumber − 1) × PageSize` reaches 300, every further page comes back empty *and* `TotalCount`
drops to 0. Measured across 11 page-width/page-number combinations — the stop is always exactly 300,
so it is a server-side quota, not a paging bug. A plain "page until exhausted" sync therefore stops
at 300 of 12,520 services (2.4%).

What does work is `Query` — it is a genuine keyword search (`finance` → 20 hits, `搜索` → 222,
`map` → 44). So the sync fans out over a keyword list (the 26 letters, 10 digits, ~50 common terms
and the catalogue's own category names) and unions the results by id:

| Keywords | Indexed | Coverage | Requests |
|---|---|---|---|
| 36 (letters + digits) | 7,132 | 57.0% | 100 |
| 80 | 8,331 | 66.6% | ~155 |
| 160 | 8,403 | 67.1% | 236 |

Returns flatten out fast — the last 80 keywords added 72 records — so the default word list stops at
96. One sync takes roughly 4 minutes and ~160 requests, which is why it runs in the background and
shares an in-flight lock with the manual button.

The remaining gap is covered at search time: when you type a query, the panel asks the marketplace
live as well and merges both result sets.

### Why stdio MCPs fail in the desktop app (launched from the Dock)

The desktop build (`DeepSeek Harness.app`) inherits only launchd's default `PATH`
(`/usr/bin:/bin:/usr/sbin:/sbin`) when started from the Dock or Finder — none of which contains
the user's own `npx` / `uvx` / `pnpm`, and those are exactly what most marketplace stdio servers
use as their command. The symptom is `连接失败：spawn uvx ENOENT`: **HTTP servers keep working,
every local-command server fails.** It looks like "some servers are broken" when in fact the
launch method simply left a few directories out of the host environment.

Launching the same app from a terminal is unaffected (`zsh` has already exported the paths from
`.zprofile` / `.zshrc`), so this is about *how the app was started*, not about a wrong config.

The plugin repairs it by itself: on load, any candidate directory that exists but is missing from
the host `PATH` (`~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, `/opt/local/bin`, …) is
prepended to `process.env.PATH`. Writing that one place is enough — the official
`@deepseek-ai/dsh-mcp-client` builds child environments from the very same `process.env`, so the
**connection test and the real startup are fixed together**, with no config file touched.

| Option | Default | Meaning |
|---|---|---|
| `fixHostPath` | `true` | set to `false` to never touch the host `PATH` |
| `probeLoginShell` | `true` | also ask the login shell (`$SHELL -lc`) for its full `PATH` (falling back to `/bin/zsh` → `/bin/bash` → `/bin/sh` when `$SHELL` is unset); set to `false` to use only the built-in candidates |

Boundaries:

- prepend only — not a single inherited entry is dropped; only directories that **exist** and are
  not already on the `PATH` are added;
- when the host `PATH` is already fine (e.g. terminal launch) **not a byte is changed**;
- once every directory is present the pending set is empty, so repeated loads are idempotent;
- disabled on Windows (different separator and `PATHEXT` semantics);
- a **runtime** repair: no file is written, and restarting the app restores the system as it was.

To keep control yourself, set `fixHostPath: false` and put a `PATH` in the `env` of the row
instead (`config.env` merges after the parent environment, and the official client and the plugin's
probe behave identically):

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

### Why "Test connection" answers instantly

A stdio connection spends nearly all of its time on **startup**, not on the protocol itself.
Measured with the real SDK:

| Scenario | connect | listTools | close | Total |
|---|---|---|---|---|
| `uvx` stdio, **first run** | 5023ms | 4ms | 74ms | 5.1s |
| Same server, **second run on** | ~475ms | 2ms | 71ms | 545ms |
| HTTP transport | 128ms | 69ms | 1ms | 197ms |

`uvx --help` takes 14ms — the uv binary is not the problem; it is the per-run rebuild of the
package environment. `listTools` itself costs 2ms. So every optimisation targets "stop paying
the startup cost twice":

1. **A running server is read from the host**: the live connection already exists, so its
   registered tools are read straight from the host instead of spawning another process
   (545ms → sub-millisecond).
2. **Closing is off the return path**: the result is handed back immediately and the child
   process is reaped in the background (~70ms saved).
3. **The button shows elapsed seconds**: a first run can take several seconds, and a frozen
   "Testing…" is harder to wait for than a ticking counter.

There is a boundary worth keeping on point 1: a row only counts as live when the fiber is
`active` **and** at least one tool is registered. A stdio server that fails to start still leaves
the fiber `active` (the official default is `failOnStartupError: false`) — only the tool count
stays honestly at 0. Those rows go through a real connection, otherwise you would be shown
"Connected, 0 tools", which is harder to debug than an outright error.

Remember this signature when debugging: **green dot + `stdio` + 0 tools = it never started.**

### "Connection closed": where the reason went, and why some servers never install

Once the `PATH` fix lands, the error changes from `spawn npx ENOENT` to
`MCP error -32000: Connection closed`. That is progress, not a new fault: the process
started, and then crashed on its own. But the interface still shows nothing useful — the
reason is printed to the child's stderr, and the transport defaults to `stderr: "inherit"`,
so those lines go straight to the host's stderr and never reach the panel.

Stdio transports now use `stderr: "pipe"` and fold the tail (6 lines / 2 KB max, ANSI
colour codes stripped) into the error:

```
Connection failed: MCP error -32000: Connection closed
子进程输出：
boom: cannot find module '@modelcontextprotocol/sdk/types.js'
详情：模块解析失败，请检查依赖是否装全
```

The `子进程输出：` header is verbatim: host-side probe messages are still Chinese-only,
unlike the panel's bilingual copy. The child's own output is passed through untouched.

There is a second, nastier trap: **"Test connection" kills the install it is waiting on.**

The first `npx -y <pkg>` run has to download the package into `~/.npm/_npx/<hash>/`. One
real case (`12306-mcp`) pulls 200+ dependencies and ran **8m44s** without finishing
`node_modules`, while the 15-second probe timeout had long since killed it. What npm leaves
behind after an interrupted unpack does not self-heal:

- the nested `node_modules` is an empty directory;
- `.package-lock.json` records the dependency as `{}`;
- a pile of `.pkg-<random>` staging directories is left around.

npx never repairs that state — so every tap on "Test connection" interrupts the install
again, forever. The current handling:

| Stage | Behaviour |
|---|---|
| Cold-start detection | Command is `npx` and `~/.npm/_npx` has no such package → cold |
| Budget | 60 s when cold (15 s stays the warm budget) |
| **On timeout** | **The process is not killed** — it keeps running for 3 minutes to finish |
| Panel | After 5 s it says "first run downloads dependencies…" and shows elapsed seconds |
| Button | Disabled while testing — two package runners writing one cache only makes it worse |

So "test once → wait a minute → test again" succeeds, and the wait is visibly making progress.

Detection is deliberately conservative: only `npx` can be checked precisely; `uvx` / `pnpx` /
`bunx` all report "unknown" and are treated as warm. Better to skip a long budget than to make
every server wait a minute.

If you are already stuck on a broken cache, the plugin now recognises it and puts the path
straight into the error:

```
Connection failed: MCP error -32000: Connection closed
子进程输出：
  code: 'ERR_MODULE_NOT_FOUND',
  url: 'file:///Users/you/.npm/_npx/a1b2c3d4e5f60718/node_modules/mcp-http-server/node_modules/@modelcontextprotocol/sdk/types.js'
这个包的缓存不完整（上次安装被中断，留下一个空壳目录），npx 不会自动修复。清掉后重装即可：rm -rf "/Users/you/.npm/_npx/a1b2c3d4e5f60718"，再在终端里跑一次 npx -y <包名> 等它装完。
```

There are two ways out: **repair in place** (fast, recommended) or **start over** (slow, but
guaranteed clean).

npm keeps downloaded packages in its content-addressed store at `~/.npm/_cacache`, so
re-unpacking them needs no download:

```bash
D=~/.npm/_npx/<hash>          # the path from the error

# Half-finished debris: `.pkg-<random>` staging directories npm left mid-unpack
find "$D/node_modules" -maxdepth 1 -type d -name '.*-*' -delete
# Empty shells: the directory exists but has no files — this is what npx keeps loading from
find "$D/node_modules" -type d -empty -delete

cd "$D" && npm install        # unpack whatever package-lock.json says is missing
```

Only empty directories and npm's own staging leftovers are removed — neither holds real data,
and the packages that did install are left alone.

If you would rather start clean, delete the whole directory. Note that you **must reuse the
exact command from your config**: npx derives the cache directory name from the command, so a
different command installs somewhere else entirely.

```bash
rm -rf ~/.npm/_npx/<hash>
npx -y <pkg>     # the command from your MCP config; it starts and stays there once installed — wait, then Ctrl+C
```

## Scheduled sync

Two triggers, one shared lock — a manual sync and a scheduled one never run at the same time:

| Trigger | When | Default |
|---|---|---|
| **Manual** | You press **Sync catalog** in the panel | always available |
| **Startup** | Once per boot, only if the local cache is missing or older than 6 hours | on, 15 s after boot |
| **Interval** | Every `intervalHours` while DSH runs | every 24 h |

Configure it by adding a row with the **same `id`** to your profile's `cordis.patch.yml` — the
profile layer wins, and a patch replaces the whole `config`, so restate every key you want to keep:

```yaml
- id: mcp-market
  name: dsh-mcp-market
  config:
    autoSync: false        # turn the interval off entirely
    intervalHours: 12      # 0.25 – 168
    syncOnStart: true
    startDelayMs: 30000
    maxRequests: 400       # keyword fan-out request budget
```

Config edits hot-reload through HMR. The panel's status line always shows the current schedule and
the last sync time. Timers are bound to the plugin's lifetime and are cleared on unload or reload,
so nothing keeps polling after the plugin is disabled.

## Compatibility

| Surface | Status |
|---|---|
| DeepSeek Harness | `0.1.7-rc.1` (verified) |
| Node | `^22.19.0 \|\| >=24.0.0` |
| Platforms | All (plain ESM, no native code) |
| Model | Any (no model interaction) |

## Development

```bash
node test/patch.test.mjs         # config-file safety (rewrite, coexistence, validation)
node test/market.test.mjs        # filtering, conversion, diffing + live catalogue checks
node test/scheduler.test.mjs     # sync schedule: config clamping, lifecycle, concurrency
node test/keywords.test.mjs      # keyword fan-out + the 300-row anonymous cap
node test/status.test.mjs        # loader entry lookup, fiber phase, registered tools and their names
node test/host-path.test.mjs     # host PATH repair: idempotence, prepend-only, fallbacks, switches
node test/package-runner.test.mjs # runner detection + cold-start check (never guesses)
node test/gateway-live.test.mjs  # reading a running server from the host (incl. "green dot lies" fallback)
node test/probe-close.test.mjs   # probing: closing off the return path + millisecond-fast failures
node test/probe-recovery.test.mjs # stderr pass-through + not killing a cold-start install + broken-cache hint
node test/client-render.test.mjs # renders the client bundle without a browser + source guards
node test/wire-contract.test.mjs # host manifest ↔ client contribution parity + reserved names
```

`market.test.mjs` and `keywords.test.mjs` need network access; set `SKIP_ONLINE=1` (or lose the
connection) to run only their offline sections. `client-render.test.mjs` installs the client bundle
through a stub module loader and renders it with `react-dom/server` — it catches runtime-only faults
such as an undefined identifier that would otherwise blank the panel. It also carries a set of
**source-contract guards** for things a syntax check cannot see: theme-token spelling (below) and
stray uses of native `window.confirm`.

### Theme tokens (a trap worth knowing)

A misspelled CSS custom property **fails silently** — it just falls back to the inherited colour, so
the panel looks subtly wrong with nothing in the console. Measured against the light theme:

- `--dsw-alias-state-warn-primary` ✅ exists (`#f59e0b`)
- `--dsw-alias-state-warning-primary` ❌ undefined

Two places in this plugin used the latter, which left the `loading` status dot with no background
colour at all. They now use a fallback chain,
`var(--dsw-alias-state-warn-primary,var(--dsw-alias-state-warning-primary,#f59e0b))`, and
`client-render.test.mjs` checks every token used against a verified allowlist.

> The theme tokens are injected at runtime onto `<body>` — not `document.documentElement`, and not
> as enumerable CSSOM rules. The only way to check them is `getComputedStyle(document.body)`.

## Uninstall

```bash
dsh plugin --profile web remove dsh-mcp-market
```

Servers you installed stay in `cordis.patch.yml` (they are ordinary DSH MCP rows). Remove them from
the Installed tab first if you want the file left clean.

## License

MIT
