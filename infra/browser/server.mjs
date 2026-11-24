// Сервис рендера публичных страниц для адаптеров маркетплейсов.
// POST /render {url, waitFor?, timeoutMs?} → {status, finalUrl, title, html}
// Ограничения: только хосты из ALLOWED_HOSTS, не чаще MIN_INTERVAL_MS на хост, свежий контекст без cookies,
// картинки/шрифты/медиа не грузим. Никаких обходов: если сайт показал капчу — отдаём как есть, адаптер остановится.
import http from "node:http";
import process from "node:process";
import { chromium } from "playwright-core";

const PORT = Number(process.env.PORT ?? 3100);
const MIN_INTERVAL_MS = Number(process.env.MIN_INTERVAL_MS ?? 10_000);
const MAX_HTML = 8 * 1024 * 1024;
const ALLOWED = new Set(
  (
    process.env.ALLOWED_HOSTS ??
    "market.yandex.ru,www.ozon.ru,ozon.ru,www.wildberries.ru,wildberries.ru"
  )
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean),
);

const lastByHost = new Map();
let browser;
let busy = Promise.resolve();

const log = (msg, data = {}) =>
  process.stdout.write(
    `${JSON.stringify({ time: new Date().toISOString(), service: "browser", msg, ...data })}\n`,
  );

async function getBrowser() {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({ headless: true });
  }
  return browser;
}

async function render({ url, waitFor, timeoutMs = 30_000 }) {
  const target = new URL(url);
  if (target.protocol !== "https:" || !ALLOWED.has(target.hostname)) {
    return {
      code: 403,
      body: { error: `host not allowed: ${target.hostname}` },
    };
  }
  const now = Date.now();
  const last = lastByHost.get(target.hostname) ?? 0;
  if (now - last < MIN_INTERVAL_MS) {
    return {
      code: 429,
      body: {
        error: "rate limited",
        retryAfterMs: MIN_INTERVAL_MS - (now - last),
      },
    };
  }
  lastByHost.set(target.hostname, now);

  const context = await (
    await getBrowser()
  ).newContext({
    locale: "ru-RU",
    timezoneId: "Asia/Tomsk",
    viewport: { width: 1366, height: 900 },
  });
  try {
    await context.route("**/*", (route) =>
      ["image", "media", "font"].includes(route.request().resourceType())
        ? route.abort()
        : route.continue(),
    );
    const page = await context.newPage();
    const started = Date.now();
    const response = await page.goto(target.href, {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    });
    if (waitFor) {
      await page
        .waitForSelector(waitFor, {
          timeout: Math.max(1000, timeoutMs - (Date.now() - started)),
        })
        .catch(() => undefined);
    }
    await page
      .waitForLoadState("networkidle", { timeout: 5000 })
      .catch(() => undefined);
    const html = (await page.content()).slice(0, MAX_HTML);
    const body = {
      status: response?.status() ?? 0,
      finalUrl: page.url(),
      title: await page.title(),
      html,
    };
    log("render", {
      host: target.hostname,
      status: body.status,
      ms: Date.now() - started,
      bytes: html.length,
    });
    return { code: 200, body };
  } finally {
    await context.close().catch(() => undefined);
  }
}

const server = http.createServer((req, res) => {
  const reply = (code, body) => {
    res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  };
  if (req.method === "GET" && req.url === "/health")
    return reply(200, { ok: true });
  if (req.method !== "POST" || req.url !== "/render")
    return reply(404, { error: "not found" });

  let raw = "";
  req.on("data", (chunk) => {
    raw += chunk;
    if (raw.length > 64 * 1024) req.destroy();
  });
  req.on("end", () => {
    // по одному рендеру за раз: меньше памяти и нагрузки на сайты
    busy = busy
      .then(async () => {
        const { code, body } = await render(JSON.parse(raw));
        reply(code, body);
      })
      .catch((error) => {
        log("error", { error: String(error) });
        reply(502, { error: String(error?.message ?? error) });
      });
  });
});

server.listen(PORT, () =>
  log("listening", { port: PORT, allowed: [...ALLOWED] }),
);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    server.close();
    await browser?.close().catch(() => undefined);
    process.exit(0);
  });
}
