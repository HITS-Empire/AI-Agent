export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

interface SearxResponse {
  results?: Array<{ title?: string; url?: string; content?: string }>;
}

/** JSON-выдача своего SearXNG. Адрес задаёт владелец (compose), не модель. */
export async function searchWeb(options: {
  baseUrl: string;
  query: string;
  limit: number;
  fetchImpl?: typeof fetch;
}): Promise<SearchHit[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const endpoint = new URL(
    "/search",
    options.baseUrl.endsWith("/") ? options.baseUrl : `${options.baseUrl}/`,
  );
  endpoint.searchParams.set("q", options.query);
  endpoint.searchParams.set("format", "json");
  endpoint.searchParams.set("language", "ru-RU");
  const response = await fetchImpl(endpoint, {
    headers: { accept: "application/json", "user-agent": "burmalda" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`SearXNG HTTP ${response.status}`);
  }
  const body = (await response.json()) as SearxResponse;
  if (!Array.isArray(body.results)) {
    throw new Error("SearXNG: неожиданный ответ (нет results)");
  }
  return body.results.slice(0, options.limit).map((hit) => ({
    title: hit.title?.trim() || hit.url || "без названия",
    url: hit.url ?? "",
    snippet: (hit.content ?? "").replace(/\s+/g, " ").trim(),
  }));
}
