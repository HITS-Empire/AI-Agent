import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { McpClient, mcpToolName, registerMcpTools } from "./client";
import { JsonRpcRemoteError } from "./jsonrpc";
import { parseSseData } from "./httpTransport";
import { parseMcpConfig } from "./config";
import { ToolRegistry } from "../tools/registry";

const fixture = fileURLToPath(
  new URL("./fixtures/fakeMcpServer.mjs", import.meta.url),
);

test("stdio: initialize, пагинация tools/list, tools/call, ошибки, ping от сервера", async () => {
  const logs: string[] = [];
  const client = new McpClient(
    {
      name: "fake",
      transport: "stdio",
      command: process.execPath,
      args: [fixture],
    },
    { onLog: (line) => logs.push(line) },
  );
  await client.connect();
  try {
    assert.equal(client.serverInfo?.name, "fake");
    assert.equal(client.protocolVersion, "2025-06-18");

    const tools = await client.listTools();
    assert.deepEqual(
      tools.map((t) => t.name),
      ["echo", "add", "fail"],
    );

    assert.equal(
      await client.callTool("echo", { text: "привет" }),
      "echo: привет",
    );
    assert.equal(await client.callTool("add", { a: 2, b: 3 }), '{"sum":5}');
    assert.equal(
      await client.callTool("fail", {}),
      "Ошибка MCP-инструмента: сломалось",
    );
    await assert.rejects(client.callTool("missing", {}), JsonRpcRemoteError);

    // сервер получил ответ на свой ping
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(logs.some((l) => l.includes("pong {}")));
  } finally {
    await client.close();
  }
});

test("stdio: инструменты сервера регистрируются в реестре и вызываются агентом", async () => {
  const client = new McpClient({
    name: "fake",
    transport: "stdio",
    command: process.execPath,
    args: [fixture],
  });
  await client.connect();
  try {
    const registry = new ToolRegistry();
    const names = await registerMcpTools(client, registry);
    assert.deepEqual(names, [
      "mcp__fake__echo",
      "mcp__fake__add",
      "mcp__fake__fail",
    ]);
    const outcome = await registry.call("mcp__fake__echo", '{"text":"x"}', {
      sessionId: "s",
      taskId: "t",
      workspaceRoot: "/",
      requestApproval: async () => true,
    });
    assert.deepEqual(outcome, { ok: true, content: "echo: x" });
  } finally {
    await client.close();
  }
});

test("stdio: внятная ошибка, если команды нет", async () => {
  const client = new McpClient({
    name: "x",
    transport: "stdio",
    command: "/nonexistent/burmalda-mcp",
  });
  await assert.rejects(client.connect(), /Не удалось запустить MCP-сервер/);
});

/** Мини-сервер Streamable HTTP: initialize — JSON + Mcp-Session-Id, tools/list — SSE, notifications — 202. */
async function startHttpServer() {
  const seen: Array<{
    method?: string;
    session?: string;
    version?: string;
    httpMethod: string;
  }> = [];
  const server = createServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === "DELETE") {
        seen.push({
          httpMethod: "DELETE",
          session: req.headers["mcp-session-id"] as string,
        });
        res.writeHead(200).end();
        return;
      }
      let body = "";
      for await (const chunk of req) body += chunk;
      const message = JSON.parse(body);
      seen.push({
        httpMethod: "POST",
        method: message.method,
        session: req.headers["mcp-session-id"] as string | undefined,
        version: req.headers["mcp-protocol-version"] as string | undefined,
      });
      if (!String(req.headers.accept).includes("text/event-stream")) {
        res.writeHead(406).end();
        return;
      }
      if (message.method === "initialize") {
        res.writeHead(200, {
          "content-type": "application/json",
          "mcp-session-id": "sess-42",
        });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              serverInfo: { name: "http-fake" },
            },
          }),
        );
      } else if (!("id" in message)) {
        res.writeHead(202).end();
      } else if (message.method === "tools/list") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        // уведомление, а затем ответ — двумя событиями, второе разбито на чанки
        res.write(
          `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "hi" } })}\n\n`,
        );
        const payload = JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            tools: [
              {
                name: "search_repos",
                description: "Поиск",
                inputSchema: { type: "object" },
              },
            ],
          },
        });
        res.write(`data: ${payload.slice(0, 20)}`);
        setTimeout(() => res.end(`${payload.slice(20)}\n\n`), 10);
      } else if (message.method === "tools/call") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              content: [
                {
                  type: "text",
                  text: `repos for ${message.params.arguments.q}`,
                },
              ],
            },
          }),
        );
      }
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    seen,
    close: () => new Promise((r) => server.close(r)),
  };
}

test("http: сессия, версия протокола в заголовках, JSON и SSE-ответы, DELETE при закрытии", async () => {
  const srv = await startHttpServer();
  const logs: string[] = [];
  const client = new McpClient(
    {
      name: "gh",
      transport: "http",
      url: srv.url,
      headers: { authorization: "Bearer test" },
    },
    { onLog: (l) => logs.push(l) },
  );
  try {
    await client.connect();
    const tools = await client.listTools();
    assert.equal(tools[0]?.name, "search_repos");
    assert.equal(
      await client.callTool("search_repos", { q: "burmalda" }),
      "repos for burmalda",
    );
    await client.close();

    assert.equal(srv.seen[0]?.session, undefined);
    assert.equal(srv.seen[1]?.method, "notifications/initialized");
    assert.equal(srv.seen[1]?.session, "sess-42");
    assert.equal(srv.seen[1]?.version, "2025-06-18");
    assert.equal(srv.seen.at(-1)?.httpMethod, "DELETE");
    assert.ok(
      logs.some((l) => l.includes("notifications") || l.includes('"hi"')),
    );
  } finally {
    await srv.close();
  }
});

test("parseSseData склеивает многострочное data", () => {
  assert.equal(parseSseData("event: message\ndata: a\ndata: b"), "a\nb");
  assert.equal(parseSseData(": comment"), null);
});

test("mcpToolName: допустимые символы и длина", () => {
  assert.equal(
    mcpToolName("git hub", "search.repos"),
    "mcp__git_hub__search_repos",
  );
  assert.ok(mcpToolName("s", "x".repeat(100)).length <= 64);
});

test("parseMcpConfig: подстановка ${VAR}, пропуск серверов без переменных", () => {
  const raw = JSON.stringify({
    mcpServers: {
      github: {
        url: "https://api.githubcopilot.com/mcp/",
        headers: { Authorization: "Bearer ${GITHUB_TOKEN}" },
      },
      local: { command: "node", args: ["${HOME_DIR}/server.js"] },
      off: { command: "x", disabled: true },
    },
  });
  const withToken = parseMcpConfig(raw, {
    GITHUB_TOKEN: "ghp_x",
    HOME_DIR: "/h",
  });
  assert.equal(withToken.servers.length, 2);
  assert.deepEqual(withToken.servers[0], {
    name: "github",
    transport: "http",
    url: "https://api.githubcopilot.com/mcp/",
    headers: { Authorization: "Bearer ghp_x" },
  });
  const without = parseMcpConfig(raw, { HOME_DIR: "/h" });
  assert.deepEqual(
    without.servers.map((s) => s.name),
    ["local"],
  );
  assert.match(
    without.skipped.find((s) => s.name === "github")!.reason,
    /GITHUB_TOKEN/,
  );
});
