import { notImplemented } from "@burmalda/shared";
import type { CalendarEvent, ExternalScheduleSource } from "./types";

/**
 * Запасной внешний календарь: любой публичный iCal-фид по HTTP (например, расписание турниров).
 * TODO(B): свой парсер VEVENT (DTSTART/DTEND с TZID и UTC, SUMMARY, LOCATION, разворот строк), без RRULE на первом этапе.
 */
export class IcsSource implements ExternalScheduleSource {
  readonly name = "iCal";

  constructor(private readonly url: string) {}

  async getEvents(_from: Date, _to: Date): Promise<CalendarEvent[]> {
    return notImplemented(`iCal-фид ${this.url}`);
  }
}
