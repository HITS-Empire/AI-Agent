import { htmlToText } from "./html";
import { assertPublicHttpUrl, type ResolveHost } from "./ssrf";

export interface PageText {
  title: string;
  url: string;
  text: string;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/**
 * Скачать публичную страницу и оставить текст.
 * Редиректы проверяются заново: переход на частный адрес обрывается.
 */
export async function fetchPage(
  rawUrl: string,
  options: {
    maxChars?: number;
    fetchImpl?: typeof fetch;
    resolveHost?: ResolveHost;
  } = {},
): Promise<PageText> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxChars = options.maxChars ?? 8_000;
  let current = await assertPublicHttpUrl(rawUrl, options.resolveHost);
  for (let hop = 0; hop < 5; hop += 1) {
    const response = await fetchImpl(current, {
      redirect: "manual",
      headers: { accept: "text/html,text/plain,*/*", "user-agent": "burmalda" },
      signal: AbortSignal.timeout(15_000),
    });
    if (REDIRECTS.has(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error("Редирект без адреса");
      current = await assertPublicHttpUrl(
        new URL(location, current).href,
        options.resolveHost,
      );
      continue;
    }
    if (!response.ok) throw new Error(`Страница HTTP ${response.status}`);
    const raw = await readLimited(response, 1_000_000);
    const type = response.headers.get("content-type") ?? "";
    const parsed = type.includes("text/plain")
      ? { title: "", text: raw.trim() }
      : htmlToText(raw);
    return {
      title: parsed.title,
      url: current.href,
      text: parsed.text.slice(0, maxChars),
    };
  }
  throw new Error("Слишком много редиректов");
}

async function readLimited(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return (await response.text()).slice(0, maxBytes);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      chunks.push(value.slice(0, value.byteLength - (total - maxBytes)));
      await reader.cancel();
      break;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}
