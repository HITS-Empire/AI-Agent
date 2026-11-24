// Минимальный MCP-сервер для тестов клиента: stdio, JSON по строке.
import process from "node:process";
import { createInterface } from "node:readline";

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const tools = [
  {
    name: "echo",
    description: "Повторяет текст",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
  {
    name: "add",
    description: "Складывает",
    inputSchema: {
      type: "object",
      properties: { a: { type: "number" }, b: { type: "number" } },
    },
  },
  {
    name: "fail",
    description: "Всегда ошибка",
    inputSchema: { type: "object", properties: {} },
  },
];
let initialized = false;

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  process.stderr.write(`got ${message.method ?? "response"}\n`);
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "fake", version: "1.0" },
      },
    });
  } else if (message.method === "notifications/initialized") {
    initialized = true;
    // сервер может сам спросить клиента — клиент обязан ответить на ping
    send({ jsonrpc: "2.0", id: "srv-1", method: "ping" });
  } else if (message.method === "tools/list") {
    if (!initialized)
      return send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32002, message: "not initialized" },
      });
    // две страницы — проверка пагинации
    if (!message.params?.cursor)
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: { tools: tools.slice(0, 2), nextCursor: "p2" },
      });
    else
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: { tools: tools.slice(2) },
      });
  } else if (message.method === "tools/call") {
    const { name, arguments: args } = message.params;
    if (name === "echo")
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: { content: [{ type: "text", text: `echo: ${args.text}` }] },
      });
    else if (name === "add")
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: { content: [], structuredContent: { sum: args.a + args.b } },
      });
    else if (name === "fail")
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          isError: true,
          content: [{ type: "text", text: "сломалось" }],
        },
      });
    else
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32602, message: `unknown tool ${name}` },
      });
  } else if (message.id === "srv-1") {
    process.stderr.write(`pong ${JSON.stringify(message.result)}\n`);
  }
});
