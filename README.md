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
  and arguments (or endpoint), and environment variables as key/value rows you can add or drop.
  It goes through the **same write path** as a catalogue install — same duplicate and clash checks,
  same managed block, hot-loaded by DSH with no restart.
- 🤝 **Plays well with others** — this plugin only ever rewrites its own marked block in
  `cordis.patch.yml`. Other plugins' rows (including `dsh-skill-mcp-panel`) are preserved byte for byte.

## Install

```bash
dsh plugin --profile web add dsh-mcp-market
```

Or from a tarball:

```bash
dsh plugin --profile web add ./dsh-mcp-market-0.1.0.tgz
```

The bundle patch mounts the plugin automatically — no manual `cordis.patch.yml` editing.
Restart the web profile once, then open **MCP Market** in the left sidebar.

> **On pnpm 9:** if the install fails with
> `ERR_PNPM_ADDING_TO_ROOT — Running this command will add the dependency to the workspace root`,
> the profile directory contains a DSH-generated `pnpm-workspace.yaml` (`packages: [.]`) which pnpm
> treats as a workspace root. Do what the message says and add `-w`:
>
> ```bash
> dsh plugin --profile web add -w dsh-mcp-market
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
node test/status.test.mjs        # loader entry lookup, fiber phase, registered tool count
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
