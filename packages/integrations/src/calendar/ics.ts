import type { CalendarEvent, ExternalScheduleSource } from "./types";
import { overlaps, parseIcs } from "./icsParse";

/**
 * Запасной внешний календарь: публичный iCal-фид по HTTP.
 * Адрес задаёт владелец в EXTERNAL_CALENDAR_ICS_URL.
 */
export class IcsSource implements ExternalScheduleSource {
  readonly name = "iCal";

  constructor(
    private readonly url: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async getEvents(from: Date, to: Date): Promise<CalendarEvent[]> {
    const parsed = new URL(this.url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("iCal-фид: только http и https");
    }
    const response = await this.fetchImpl(parsed, {
      headers: { accept: "text/calendar,*/*", "user-agent": "burmalda" },
      signal: AbortSignal.timeout(15_000),
    });
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
