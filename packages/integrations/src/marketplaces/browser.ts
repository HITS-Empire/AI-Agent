import {
  MarketplaceBlockedError,
  type BlockReason,
  type MarketplaceId,
} from "./types";

/** Ответ сервиса рендера (infra/browser): HTML после выполнения скриптов страницы. */
export interface RenderedPage {
  /** HTTP-статус основного документа. */
  status: number;
  finalUrl: string;
  title: string;
  html: string;
}

export interface PageRenderer {
  render(
    url: string,
    options?: { waitFor?: string; timeoutMs?: number },
    signal?: AbortSignal,
  ): Promise<RenderedPage>;
}

/** Сервис рендера отказал по своему лимиту частоты (одна страница на сайт за MIN_INTERVAL_MS). */
export class RenderRateLimitedError extends Error {
  constructor(readonly retryAfterMs: number) {
    super(`сервис браузера: лимит частоты, повтор через ${retryAfterMs} мс`);
  }
}

export interface BrowserRendererOptions {
  /** URL сервиса infra/browser, по умолчанию BROWSER_URL или http://127.0.0.1:3100 */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Клиент сервиса рендера. Сам браузер (Playwright/Chromium headless) живёт в отдельном контейнере
 * без привилегий; здесь только HTTP. Без входа в аккаунты, без stealth-плагинов и подмены отпечатков.
 */
export function createBrowserRenderer(
  options: BrowserRendererOptions = {},
): PageRenderer {
  const baseUrl = (
    options.baseUrl ??
    process.env.BROWSER_URL ??
    "http://127.0.0.1:3100"
  ).replace(/\/$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    async render(url, renderOptions = {}, signal) {
      const timeoutMs = renderOptions.timeoutMs ?? 30_000;
      const timeout = AbortSignal.timeout(timeoutMs + 15_000);
      const response = await fetchImpl(`${baseUrl}/render`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url, ...renderOptions, timeoutMs }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      const body = (await response.json().catch(() => ({}))) as Partial<
        RenderedPage & { error: string; retryAfterMs: number }
      >;
      if (response.status === 429)
        throw new RenderRateLimitedError(body.retryAfterMs ?? 0);
      if (!response.ok || typeof body.html !== "string")
        throw new Error(
          `сервис браузера: HTTP ${response.status}${body.error ? ` (${body.error})` : ""}`,
        );
      return {
        status: body.status ?? 0,
        finalUrl: body.finalUrl ?? url,
        title: body.title ?? "",
        html: body.html,
      };
    },
  };
}

/**
 * Открыть страницу поиска и проверить, что это выдача, а не защита сайта.
 * Капча/антибот/403/429 → MarketplaceBlockedError: адаптер останавливается, ничего не обходит.
 */
export async function loadSearchPage(
  renderer: PageRenderer,
  marketplace: MarketplaceId,
  url: string,
  check: {
    waitFor?: string;
    /** Признаки страницы защиты сайта (капча, антибот, бан) вместо выдачи. */
    blocked: (page: RenderedPage) => BlockReason | undefined;
  },
  signal?: AbortSignal,
): Promise<RenderedPage> {
  let page: RenderedPage;
  try {
    page = await renderer.render(
      url,
      check.waitFor ? { waitFor: check.waitFor } : {},
      signal,
    );
  } catch (error) {
    if (error instanceof RenderRateLimitedError)
      throw new MarketplaceBlockedError(marketplace, "rate_limited");
    throw error;
  }
  const reason = check.blocked(page);
  if (reason) throw new MarketplaceBlockedError(marketplace, reason);
  if (page.status === 429)
    throw new MarketplaceBlockedError(marketplace, "rate_limited");
  if (page.status === 403 || page.status === 498)
    throw new MarketplaceBlockedError(marketplace, "forbidden");
  if (page.status >= 400)
    throw new Error(`${marketplace}: HTTP ${page.status}`);
  return page;
}

/** Фиктивный рендерер для тестов: отдаёт сохранённый HTML. */
export function fixtureRenderer(
  html: string,
  page: Partial<RenderedPage> = {},
): PageRenderer & { urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    async render(url) {
      urls.push(url);
      return { status: 200, finalUrl: url, title: "", html, ...page };
    },
  };
}
