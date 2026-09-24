/**
 * MCP 连接探针：临时连一次服务并列出其工具。
 *
 * 不写 patch、不注册 DSH 工具，只用于「测试连接」——包括安装前预检，
 * 让用户在真正写入配置之前就知道这个服务能不能起来。
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/** 单次探测的总超时。 */
const PROBE_TIMEOUT_MS = 15000;

const CLIENT_INFO = { name: "dsh-mcp-market", version: "0.1.0" };

/**
 * 探测一个 MCP 服务。
 *
 * 任何失败都收敛成 `{ ok: false, error }`，不抛异常 —— 探测失败是预期内的常见结果。
 *
 * @param {object} config 官方形态配置（transport / command+args 或 url）。
 * @param {number} [timeoutMs]
 * @returns {Promise<{ ok: boolean, tools: {name: string, description?: string}[], error?: string }>}
 */
export async function probeMcpServer(config, timeoutMs = PROBE_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const client = new Client(CLIENT_INFO);
  let transport;

  try {
    transport = createTransport(config);
    await raceWithAbort(client.connect(transport), controller.signal);

    const tools = [];
    let cursor;
    do {
      const page = await client.listTools(cursor === undefined ? undefined : { cursor }, {
        signal: controller.signal,
      });
      for (const tool of page.tools ?? []) {
        tools.push({
          name: String(tool.name),
          ...(typeof tool.description === "string" ? { description: tool.description } : {}),
        });
      }
      cursor = page.nextCursor;
    } while (cursor !== undefined && cursor !== "");

    return { ok: true, tools };
  } catch (error) {
    const reason = controller.signal.aborted
      ? `连接测试超时（${timeoutMs}ms）`
      : error instanceof Error
        ? error.message
        : String(error);
    return { ok: false, tools: [], error: reason };
  } finally {
    clearTimeout(timer);
    await Promise.allSettled([
      client.close().catch(() => {}),
      transport?.close?.().catch(() => {}),
    ]);
  }
}

function createTransport(config) {
  if (config?.transport === "stdio") {
    return new StdioClientTransport({
      command: String(config.command ?? ""),
      args: Array.isArray(config.args) ? config.args.map(String) : [],
      env: { ...scrubbedEnv(), ...stringMap(config.env) },
      cwd: config.cwd === "" || config.cwd === undefined ? undefined : String(config.cwd),
    });
  }
  return new StreamableHTTPClientTransport(new URL(String(config?.url ?? "")), {
    requestInit: { headers: stringMap(config?.headers) },
  });
}

/**
 * 剥掉宿主进程里的敏感环境变量，避免把它们透传给被探测的第三方进程。
 * 仅保留运行所需的最小集合。
 */
function scrubbedEnv() {
  const keep = ["PATH", "HOME", "SHELL", "LANG", "LC_ALL", "TMPDIR", "USER", "SystemRoot", "ComSpec", "PATHEXT"];
  const out = {};
  for (const key of keep) {
    const value = process.env[key];
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

function stringMap(value) {
  const out = {};
  for (const [key, item] of Object.entries(value ?? {})) {
    if (typeof item === "string") out[key] = item;
  }
  return out;
}

function raceWithAbort(promise, signal) {
  if (signal.aborted) return Promise.reject(new Error("aborted"));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
