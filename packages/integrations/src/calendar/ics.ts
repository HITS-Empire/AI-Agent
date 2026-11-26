import { assertPublicHttpUrl, type ResolveHost } from "../search/ssrf";
import type { CalendarEvent, ExternalScheduleSource } from "./types";
import { overlaps, parseIcs } from "./icsParse";

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/**
 * Запасной внешний календарь: публичный iCal-фид по HTTP.
 * Адрес задаёт владелец в EXTERNAL_CALENDAR_ICS_URL.
 */
export class IcsSource implements ExternalScheduleSource {
  readonly name = "iCal";

  constructor(
    private readonly url: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly resolveHost?: ResolveHost,
  ) {}

  async getEvents(from: Date, to: Date): Promise<CalendarEvent[]> {
    let current = await assertPublicHttpUrl(this.url, this.resolveHost);
    let response: Response | undefined;
    for (let hop = 0; hop < 5; hop += 1) {
      response = await this.fetchImpl(current, {
        redirect: "manual",
        headers: { accept: "text/calendar,*/*", "user-agent": "burmalda" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!REDIRECTS.has(response.status)) break;
      const location = response.headers.get("location");
      if (!location) throw new Error("iCal-фид: редирект без адреса");
      current = await assertPublicHttpUrl(
        new URL(location, current).href,
        this.resolveHost,
      );
    }
    if (!response || REDIRECTS.has(response.status)) {
      throw new Error("iCal-фид: слишком много редиректов");
    }
    if (!response.ok) throw new Error(`iCal-фид HTTP ${response.status}`);
    return parseIcs(await response.text())
      .filter((event) => overlaps(event, from, to))
      .map((event) => ({
        id: event.uid,
        title: event.title,
        start: event.start.toISOString(),
        end: event.end.toISOString(),
        location: event.location,
        description: event.description,
        source: this.name,
      }));
  }
}
